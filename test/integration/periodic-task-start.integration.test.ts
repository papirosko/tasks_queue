import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { Option } from "scats";
import { TaskPeriodType, TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ControlledTestWorker } from "./support/controlled-test-worker.js";
import { ManualClock } from "./support/manual-clock.js";
import { TestTaskEventType, TestTaskEventsBus } from "./support/task-events-bus.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Periodic task start integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const scheduledStart = new Date(baseTime.getTime() + TimeUtils.minute);
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const worker = new ControlledTestWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker("periodic", worker);
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

  it("does not start fixed-rate task earlier than scheduled and starts it on time", async () => {
    await expectStartsOnTime(
      async () =>
        await test.tasksQueueService.scheduleAtFixedRate({
          queue: "periodic",
          name: "fixed-rate-task",
          period: TimeUtils.minute,
          startAfter: scheduledStart,
          payload: { kind: "fixed-rate" },
        }),
      TaskPeriodType.fixed_rate,
      { kind: "fixed-rate" },
      new Date(scheduledStart.getTime() + TimeUtils.minute),
    );
  });

  it("does not start fixed-delay task earlier than scheduled and starts it on time", async () => {
    await expectStartsOnTime(
      async () =>
        await test.tasksQueueService.scheduleAtFixedDelay({
          queue: "periodic",
          name: "fixed-delay-task",
          period: TimeUtils.minute,
          startAfter: scheduledStart,
          payload: { kind: "fixed-delay" },
        }),
      TaskPeriodType.fixed_delay,
      { kind: "fixed-delay" },
      new Date(scheduledStart.getTime() + TimeUtils.minute),
    );
  });

  it("does not start cron task earlier than scheduled and starts it on time", async () => {
    await expectStartsOnTime(
      async () =>
        await test.tasksQueueService.scheduleAtCron({
          queue: "periodic",
          name: "cron-task",
          cronExpression: "0 * * * * *",
          startAfter: scheduledStart,
          payload: { kind: "cron" },
        }),
      TaskPeriodType.cron,
      { kind: "cron" },
      new Date(scheduledStart.getTime() + TimeUtils.minute),
    );
  });

  async function expectStartsOnTime(
    schedule: () => Promise<Option<number>>,
    repeatType: TaskPeriodType,
    payload: object,
    expectedNextStartAfter: Date,
  ): Promise<void> {
    const taskId = await schedule();

    expect(taskId.isDefined).toBe(true);

    const scheduledTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(scheduledTask.isDefined).toBe(true);
    expect(scheduledTask.get.status).toBe(TaskStatus.pending);
    expect(scheduledTask.get.payload).toEqual(payload);
    expect(scheduledTask.get.repeatType.orUndefined).toBe(repeatType);
    expect(scheduledTask.get.startAfter.orUndefined).toEqual(scheduledStart);

    await test.tasksQueueService.runOnce();
    expect(startedEventsCount(taskId.get)).toBe(0);

    clock.set(new Date(scheduledStart.getTime() - 1));
    await test.tasksQueueService.runOnce();
    expect(startedEventsCount(taskId.get)).toBe(0);

    const beforeStartTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(beforeStartTask.isDefined).toBe(true);
    expect(beforeStartTask.get.status).toBe(TaskStatus.pending);
    expect(beforeStartTask.get.payload).toEqual(payload);

    clock.set(scheduledStart);
    const runPromise = test.tasksQueueService.runOnce();

    await expect(bus.waitForStarted(taskId.get)).resolves.toEqual({
      type: TestTaskEventType.started,
      taskId: taskId.get,
      payload,
    });

    const startedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(startedTask.isDefined).toBe(true);
    expect(startedTask.get.status).toBe(TaskStatus.in_progress);
    expect(startedTask.get.attempt).toBe(1);
    expect(startedTask.get.payload).toEqual(payload);
    expect(startedTask.get.result).toBeNull();

    worker.complete(taskId.get, { ok: true });
    await runPromise;

    const rescheduledTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(rescheduledTask.isDefined).toBe(true);
    expect(rescheduledTask.get.status).toBe(TaskStatus.pending);
    expect(rescheduledTask.get.attempt).toBe(0);
    expect(rescheduledTask.get.payload).toEqual(payload);
    expect(rescheduledTask.get.result).toEqual({ ok: true });
    expect(rescheduledTask.get.startAfter.orUndefined).toEqual(
      expectedNextStartAfter,
    );
  }

  function startedEventsCount(taskId: number): number {
    return bus
      .events(taskId)
      .count((event) => event.type === TestTaskEventType.started);
  }
});
