import { describe, expect, it, jest } from "@jest/globals";
import { some } from "scats";
import { TasksQueueDao } from "../src/tasks-queue.dao.js";
import { TaskStatus } from "../src/tasks-model.js";

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
    const started = new Date("2026-04-02T09:55:00.000Z");
    jest.useFakeTimers().setSystemTime(now);
    const query = jest.fn(async () => ({
      rows: [{ status: "in_progress", started, last_heartbeat: null }],
      rowCount: 1,
    }));
    const { dao, release } = createDao(query);

    await dao.ping(42, started);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("select status, started, last_heartbeat"),
      [42],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("set last_heartbeat = $1"),
      [now, 42, TaskStatus.in_progress, started],
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
    const started = new Date("2026-04-02T10:00:00.000Z");
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
      started,
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

  it("does not consume a parent attempt when moving task to blocked", async () => {
    const started = new Date("2026-04-02T10:00:00.000Z");
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
      },
      {
        workflowPayload: { stage: "scan" },
        userPayload: { id: 1 },
      },
      started,
    );

    expect(query.mock.calls[1][0]).toContain(
      "attempt = greatest(attempt - 1, 0)",
    );
    expect(query.mock.calls[1][0]).toContain("started = null");
    expect(query.mock.calls[1][0]).toContain("last_heartbeat = null");
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

  it("casts terminal failure result to jsonb in fail transition", async () => {
    const started = new Date("2026-04-02T10:00:00.000Z");
    const query = jest.fn(async () => ({
      rows: [{ status: "error" }],
    }));
    const { dao, release } = createDao(query);

    await dao.fail(11, "boom", { state: "failed" }, { partial: true }, started);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ELSE $8::jsonb"),
      expect.arrayContaining([
        expect.any(Date),
        "boom",
        TaskStatus.pending,
        TaskStatus.error,
        11,
        TaskStatus.in_progress,
        { state: "failed" },
        { partial: true },
        started,
      ]),
    );
    expect(release).toHaveBeenCalled();
  });

  it("clears finished tasks only when all ancestors are finished", async () => {
    const now = new Date("2026-04-02T10:00:00.000Z");
    jest.useFakeTimers().setSystemTime(now);
    const query = jest.fn(async () => ({ rows: [] }));
    const { dao, release } = createDao(query);

    await dao.clearFinished();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("with recursive ancestors as"),
      [TaskStatus.finished, new Date(now.getTime() - 24 * 60 * 60 * 1000)],
    );
    const [[sql]] = query.mock.calls as unknown as [[string, unknown[]]];
    expect(sql).toContain("ancestors.task_id = task.id");
    expect(sql).toContain("ancestors.status <> $1");
    expect(release).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
