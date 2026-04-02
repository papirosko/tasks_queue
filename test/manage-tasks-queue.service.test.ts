import { describe, expect, it, jest } from "@jest/globals";
import { ManageTasksQueueService } from "../src/manage-tasks-queue.service.js";
import { TaskStatus } from "../src/tasks-model.js";

describe("ManageTasksQueueService", () => {
  it("does not delete a task when any ancestor is unfinished", async () => {
    const query = jest.fn(async () => ({ rowCount: 1 }));
    const service = new ManageTasksQueueService({ query } as any);

    await service.deleteTask(42);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("with recursive ancestors as"),
      [
        42,
        TaskStatus.pending,
        TaskStatus.error,
        TaskStatus.finished,
        TaskStatus.finished,
      ],
    );
    const [[sql]] = query.mock.calls as unknown as [[string, unknown[]]];
    expect(sql).toContain("where child.id = $1");
    expect(sql).toContain(
      "join tasks_queue parent on parent.id = ancestors.parent_id",
    );
    expect(sql).toContain("where status <> $5");
  });
});
