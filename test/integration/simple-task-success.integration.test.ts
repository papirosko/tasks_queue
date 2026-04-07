import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { TaskStatus } from "../../src/tasks-model.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ControlledTestWorker } from "./support/controlled-test-worker.js";
import { TestTaskEventsBus } from "./support/task-events-bus.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Simple task integration", () => {
  const test = new QueueIntegrationTest();
  const bus = new TestTaskEventsBus();
  const worker = new ControlledTestWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker("email", worker);
  });

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    await test.reset();
    bus.reset();
    worker.reset();
  });

  it("starts and successfully finishes a controlled task with submitted result", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
    });

    expect(taskId.isDefined).toBe(true);

    // Reload the task right after scheduling and verify the initial persisted payload.
    const scheduledTask = await test.manageTasksQueueService.findById(
      taskId.get,
    );
    expect(scheduledTask.isDefined).toBe(true);
    expect(scheduledTask.get.payload).toEqual(payload);

    // Run one queue pass and wait until the worker actually starts the task.
    const runPromise = test.tasksQueueService.runOnce();

    await expect(bus.waitForStarted(taskId.get)).resolves.toEqual({
      type: "started",
      taskId: taskId.get,
      payload,
    });

    // Confirm that the task moved to in-progress state and no result has been persisted yet.
    const startedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(startedTask.isDefined).toBe(true);
    expect(startedTask.get.status).toBe(TaskStatus.in_progress);
    expect(startedTask.get.payload).toEqual(payload);
    expect(startedTask.get.result).toBeNull();
    expect(worker.isActive(taskId.get)).toBe(true);

    // Complete the task with a submitted result and wait for the completion event.
    worker.complete(taskId.get, { ok: true });

    await expect(bus.waitForCompleted(taskId.get)).resolves.toEqual({
      type: "completed",
      taskId: taskId.get,
      result: { ok: true },
    });
    await runPromise;

    // Reload the row and verify final finished state together with the persisted result.
    const finishedTask = await test.manageTasksQueueService.findById(
      taskId.get,
    );
    expect(finishedTask.isDefined).toBe(true);
    expect(finishedTask.get.status).toBe(TaskStatus.finished);
    expect(finishedTask.get.payload).toEqual(payload);
    expect(finishedTask.get.result).toEqual({ ok: true });
    expect(worker.isActive(taskId.get)).toBe(false);
  });
});
