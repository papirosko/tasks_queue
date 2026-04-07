import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";
import { RecordingControlledWorker } from "./support/recording-controlled-worker.js";
import { TestTaskEventsBus } from "./support/task-events-bus.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Lifecycle callbacks integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const worker = new RecordingControlledWorker(bus);

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

  it("invokes starting and completed callbacks on success", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
    });

    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);
    worker.complete(taskId.get, { ok: true });
    await bus.waitForCompleted(taskId.get);
    await runPromise;

    expect(worker.startingCalls.toArray).toEqual([{ taskId: taskId.get, payload }]);
    expect(worker.completedCalls.toArray).toEqual([{ taskId: taskId.get, payload }]);
    expect(worker.failedCalls.toArray).toEqual([]);
  });

  it("invokes failed callback with terminal error status", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
    });

    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);
    worker.fail(taskId.get, new Error("boom"));
    await bus.waitForFailed(taskId.get);
    await runPromise;

    expect(worker.startingCalls.toArray).toEqual([{ taskId: taskId.get, payload }]);
    expect(worker.completedCalls.toArray).toEqual([]);
    expect(worker.failedCalls.toArray).toEqual([
      {
        taskId: taskId.get,
        payload,
        finalStatus: TaskStatus.error,
        error: "boom",
      },
    ]);
  });

  it("invokes failed callback with pending status when task will retry", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 2,
      backoff: TimeUtils.minute,
    });

    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);
    worker.fail(taskId.get, new Error("boom"));
    await bus.waitForFailed(taskId.get);
    await runPromise;

    expect(worker.failedCalls.toArray).toEqual([
      {
        taskId: taskId.get,
        payload,
        finalStatus: TaskStatus.pending,
        error: "boom",
      },
    ]);
  });
});
