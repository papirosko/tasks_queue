import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { TaskStatus } from "../../src/tasks-model.js";
import { BaseIntegrationTest } from "./base-integration-test.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("TasksQueueService integration", () => {
  const test = new QueueIntegrationTest();

  beforeAll(async () => {
    await test.start();
  });

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    await test.reset();
  });

  it("creates a task row in postgres", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 42, action: "send" },
      priority: 7,
    });

    expect(taskId.isDefined).toBe(true);

    const task = await test.manageTasksQueueService.findById(taskId.get);

    expect(task.isDefined).toBe(true);
    expect(task.get.id).toBe(taskId.get);
    expect(task.get.queue).toBe("email");
    expect(task.get.status).toBe(TaskStatus.pending);
    expect(task.get.priority).toBe(7);
    expect(task.get.attempt).toBe(0);
    expect(task.get.maxAttempts).toBe(1);
    expect(task.get.payload).toEqual({ userId: 42, action: "send" });
  });
});
