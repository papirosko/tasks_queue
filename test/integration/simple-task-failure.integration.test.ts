import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ControlledTestWorker } from "./support/controlled-test-worker.js";
import { ManualClock } from "./support/manual-clock.js";
import { TestTaskEventsBus } from "./support/task-events-bus.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Simple task failure integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const worker = new ControlledTestWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker("email", worker);
  });

  beforeEach(async () => {
    await test.reset();
    bus.reset();
    worker.reset();
    clock.set(baseTime);
  });

  afterAll(async () => {
    await test.stop();
  });

  it("moves task to terminal error on first failure when retries are exhausted", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
    });

    expect(taskId.isDefined).toBe(true);

    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    worker.fail(taskId.get, new Error("boom"));
    await expect(bus.waitForFailed(taskId.get)).resolves.toEqual({
      type: "failed",
      taskId: taskId.get,
      error: "boom",
    });
    await runPromise;

    const failedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(failedTask.isDefined).toBe(true);
    expect(failedTask.get.status).toBe(TaskStatus.error);
    expect(failedTask.get.attempt).toBe(1);
    expect(failedTask.get.error.orUndefined).toBe("boom");
    expect(failedTask.get.payload).toEqual(payload);
    expect(failedTask.get.result).toBeNull();
    expect(worker.isActive(taskId.get)).toBe(false);
  });

  it("keeps submitted result on terminal failure", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
    });

    expect(taskId.isDefined).toBe(true);

    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    worker.failWithResult(taskId.get, new Error("boom"), { partial: true });
    await bus.waitForFailed(taskId.get);
    await runPromise;

    const failedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(failedTask.isDefined).toBe(true);
    expect(failedTask.get.status).toBe(TaskStatus.error);
    expect(failedTask.get.payload).toEqual(payload);
    expect(failedTask.get.result).toEqual({ partial: true });
    expect(failedTask.get.error.orUndefined).toBe("boom");
  });

  it("retries task after backoff when clock is advanced", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 2,
      backoff: TimeUtils.minute,
    });

    expect(taskId.isDefined).toBe(true);

    const firstRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 1);

    worker.fail(taskId.get, new Error("boom"));
    await bus.waitForFailed(taskId.get, 1);
    await firstRunPromise;

    const pendingRetryTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(pendingRetryTask.isDefined).toBe(true);
    expect(pendingRetryTask.get.status).toBe(TaskStatus.pending);
    expect(pendingRetryTask.get.attempt).toBe(1);
    expect(pendingRetryTask.get.error.orUndefined).toBe("boom");
    expect(pendingRetryTask.get.payload).toEqual(payload);
    expect(pendingRetryTask.get.result).toBeNull();
    expect(pendingRetryTask.get.startAfter.orUndefined).toEqual(
      new Date(baseTime.getTime() + TimeUtils.minute),
    );

    await test.tasksQueueService.runOnce();
    expect(
      bus.events(taskId.get).filter((event) => event.type === "started").size,
    ).toBe(1);

    clock.advance(TimeUtils.minute + 1);
    const secondRunPromise = test.tasksQueueService.runOnce();

    await expect(bus.waitForStarted(taskId.get, 2)).resolves.toEqual({
      type: "started",
      taskId: taskId.get,
      payload,
    });

    const retriedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(retriedTask.isDefined).toBe(true);
    expect(retriedTask.get.status).toBe(TaskStatus.in_progress);
    expect(retriedTask.get.attempt).toBe(2);
    expect(retriedTask.get.payload).toEqual(payload);
    expect(retriedTask.get.result).toBeNull();
    expect(worker.isActive(taskId.get)).toBe(true);

    worker.complete(taskId.get);
    await secondRunPromise;
  });

  it("clears submitted result when failure is retried", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 2,
      backoff: TimeUtils.minute,
    });

    expect(taskId.isDefined).toBe(true);

    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 1);

    worker.failWithResult(taskId.get, new Error("boom"), { partial: true });
    await bus.waitForFailed(taskId.get, 1);
    await runPromise;

    const pendingRetryTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(pendingRetryTask.isDefined).toBe(true);
    expect(pendingRetryTask.get.status).toBe(TaskStatus.pending);
    expect(pendingRetryTask.get.payload).toEqual(payload);
    expect(pendingRetryTask.get.result).toBeNull();
  });
});
