import { describe, expect, it, jest } from "@jest/globals";
import { some } from "scats";
import { TasksQueueDao } from "../src/tasks-queue.dao.js";
import { TASK_HEARTBEAT_THROTTLE_MS, TaskStatus } from "../src/tasks-model.js";

const createDao = (query: any) => {
  const release = jest.fn();
  const pool = {
    connect: jest.fn(async () => ({
      query,
      release,
    })),
  };
  return {
    dao: new TasksQueueDao(pool as any),
    pool,
    release,
  };
};

describe("TasksQueueDao", () => {
  it("updates heartbeat only for in-progress tasks", async () => {
    const now = new Date("2026-04-02T10:00:00.000Z");
    jest.useFakeTimers().setSystemTime(now);
    const query = jest.fn(async () => ({ rows: [] }));
    const { dao, release } = createDao(query);

    await dao.ping(42);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("set last_heartbeat = $1"),
      [
        now,
        42,
        TaskStatus.in_progress,
        new Date(now.getTime() - TASK_HEARTBEAT_THROTTLE_MS),
      ],
    );
    expect(release).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("detects stalled tasks from the latest heartbeat when available", async () => {
    const query: any = jest.fn();
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    query.mockResolvedValueOnce({ rows: [] });
    const { dao, release } = createDao(query);

    const res = await dao.failStalled();

    expect(res.toArray).toEqual([7]);
    expect(query.mock.calls[1][0]).toContain(
      "coalesce(child.last_heartbeat, child.started)",
    );
    expect(query.mock.calls[1][0]).toContain("greatest(");
    expect(release).toHaveBeenCalled();
  });

  it("persists active child allowFailure flag on parent payload when scheduling child", async () => {
    const query: any = jest.fn();
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 99 }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    const { dao, release } = createDao(query);

    await dao.blockParentAndScheduleChild(
      7,
      {
        queue: "child-q",
        payload: { child: true },
        allowFailure: true,
      },
      {
        workflowPayload: { stage: "scan" },
        userPayload: { id: 1 },
      },
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("set payload = $1"),
      [
        {
          activeChild: {
            taskId: 99,
            allowFailure: true,
          },
          workflowPayload: { stage: "scan" },
          userPayload: { id: 1 },
        },
        7,
        TaskStatus.blocked,
      ],
    );
    expect(release).toHaveBeenCalled();
  });

  it("loads task snapshots with payload and result", async () => {
    const query = jest.fn(async () => ({
      rows: [
        {
          id: 11,
          parent_id: 5,
          status: "finished",
          payload: { state: true },
          result: { output: true },
          error: null,
        },
      ],
    }));
    const { dao, release } = createDao(query);

    const snapshot = await dao.findTaskState(11);

    expect(snapshot.orUndefined).toEqual({
      id: 11,
      parentId: 5,
      status: TaskStatus.finished,
      payload: { state: true },
      result: some({ output: true }),
      error: undefined,
    });
    expect(release).toHaveBeenCalled();
  });
});
