import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { mutable, Option } from "scats";
import { TaskPeriodType, TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ControlledTestWorker } from "./support/controlled-test-worker.js";
import { ManualClock } from "./support/manual-clock.js";
import { TestTaskEventType, TestTaskEventsBus } from "./support/task-events-bus.js";
import { TaskContext } from "../../src/tasks-model.js";
import { TasksWorker } from "../../src/tasks-worker.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

class MultiExecutionControlledWorker extends TasksWorker {
  private readonly executions =
    new mutable.HashMap<
      number,
      mutable.ArrayBuffer<{
        context: TaskContext;
        deferred: {
          promise: Promise<void>;
          resolve: () => void;
          reject: (error: Error) => void;
        };
      }>
    >();
  private readonly submittedResults = new mutable.HashMap<string, object>();

  constructor(private readonly bus: TestTaskEventsBus) {
    super();
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    let resolveFn: (() => void) | undefined;
    let rejectFn: ((error: Error) => void) | undefined;
    const deferred = {
      promise: new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      }),
      resolve: () => resolveFn!(),
      reject: (error: Error) => rejectFn!(error),
    };
    const runs = this.executions
      .get(context.taskId)
      .getOrElse(() => new mutable.ArrayBuffer());
    runs.append({ context, deferred });
    this.executions.put(context.taskId, runs);
    this.bus.emitStarted(context.taskId, payload);
    await deferred.promise;
  }

  override async completed(taskId: number): Promise<void> {
    this.bus.emitCompleted(taskId, this.submittedResults.get(`${taskId}:2`).orUndefined);
    this.submittedResults.clear();
  }

  override async failed(
    taskId: number,
    _payload: any,
    _finalStatus: TaskStatus,
    error: any,
  ): Promise<void> {
    this.bus.emitFailed(taskId, String(error?.message ?? error));
  }

  complete(taskId: number, occurrence: number = 1, result?: object): void {
    const execution = this.execution(taskId, occurrence);
    if (result !== undefined) {
      execution.context.submitResult(result);
      this.submittedResults.put(`${taskId}:${occurrence}`, result);
    }
    execution.deferred.resolve();
  }

  reset(): void {
    this.executions.clear();
    this.submittedResults.clear();
  }

  private execution(taskId: number, occurrence: number) {
    return this.executions.get(taskId).get.get(occurrence - 1);
  }
}

describe("Periodic task start integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const scheduledStart = new Date(baseTime.getTime() + TimeUtils.minute);
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const worker = new ControlledTestWorker(bus);
  const multiRunWorker = new MultiExecutionControlledWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker("periodic", worker);
    test.tasksQueueService.registerWorker("periodic-race", multiRunWorker);
  });

  beforeEach(async () => {
    await test.reset();
    bus.reset();
    worker.reset();
    multiRunWorker.reset();
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

  it("uses timeout retry instead of periodic reschedule when completion happens after timeout", async () => {
    const taskId = await test.tasksQueueService.scheduleAtFixedRate({
      queue: "periodic",
      name: "fixed-rate-timeout",
      period: TimeUtils.minute,
      startAfter: scheduledStart,
      payload: { kind: "fixed-rate-timeout" },
      retries: 2,
      timeout: TimeUtils.second,
      backoff: TimeUtils.second * 5,
    });

    expect(taskId.isDefined).toBe(true);

    // Start the periodic attempt exactly on schedule and let it overrun its timeout window.
    clock.set(scheduledStart);
    const runPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    clock.advance(TimeUtils.second + 1);
    worker.complete(taskId.get, { stale: true });
    await bus.waitForFailed(taskId.get);
    await runPromise;

    // Timed out completion must follow normal retry semantics, not periodic timer rescheduling.
    const retriedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(retriedTask.isDefined).toBe(true);
    expect(retriedTask.get.status).toBe(TaskStatus.pending);
    expect(retriedTask.get.attempt).toBe(1);
    expect(retriedTask.get.error.orUndefined).toBe("Timeout");
    expect(retriedTask.get.result).toBeNull();
    expect(retriedTask.get.startAfter.orUndefined).toEqual(
      new Date(clock.now().getTime() + TimeUtils.second * 5),
    );
    expect(retriedTask.get.startAfter.orUndefined).not.toEqual(
      new Date(scheduledStart.getTime() + TimeUtils.minute),
    );
  });

  it("does not let a stale periodic attempt shift the timer after retry starts", async () => {
    const taskId = await test.tasksQueueService.scheduleAtFixedRate({
      queue: "periodic-race",
      name: "fixed-rate-race",
      period: TimeUtils.minute,
      startAfter: scheduledStart,
      payload: { kind: "fixed-rate-race" },
      retries: 2,
      timeout: TimeUtils.second,
      backoff: 0,
    });

    expect(taskId.isDefined).toBe(true);

    // First periodic run stalls and becomes immediately retryable.
    clock.set(scheduledStart);
    const firstRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 1);
    clock.advance(TimeUtils.second + 1);
    multiRunWorker.complete(taskId.get, 1, { stale: true });
    await bus.waitForFailed(taskId.get, 1);
    await firstRun;

    // Second run starts with a new started timestamp and now owns the periodic row.
    const secondRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 2);
    const rowWhileSecondRunActive = await test.db.query(
      `select started, status, start_after, result
         from tasks_queue
        where id = $1`,
      [taskId.get],
    );
    const secondStarted = new Date(rowWhileSecondRunActive.rows[0]["started"]);
    const retryStartAfter = new Date(rowWhileSecondRunActive.rows[0]["start_after"]);
    expect(rowWhileSecondRunActive.rows[0]["status"]).toBe(TaskStatus.in_progress);
    expect(rowWhileSecondRunActive.rows[0]["result"]).toBeNull();

    // Completing the stale first run already happened above; it must not have shifted the periodic timer.
    expect(retryStartAfter).toEqual(clock.now());

    // Current run still owns the row and may reschedule it using the real periodic schedule.
    multiRunWorker.complete(taskId.get, 2, { fresh: true });
    await secondRun;

    const rescheduledTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(rescheduledTask.isDefined).toBe(true);
    expect(rescheduledTask.get.status).toBe(TaskStatus.pending);
    expect(rescheduledTask.get.result).toEqual({ fresh: true });
    expect(rescheduledTask.get.startAfter.orUndefined).toEqual(
      new Date(scheduledStart.getTime() + TimeUtils.minute),
    );
    expect(rescheduledTask.get.startAfter.orUndefined).not.toEqual(retryStartAfter);
  });

  async function expectStartsOnTime(
    schedule: () => Promise<Option<number>>,
    repeatType: TaskPeriodType,
    payload: object,
    expectedNextStartAfter: Date,
  ): Promise<void> {
    // Create the periodic task and confirm that it is stored as pending with the requested schedule.
    const taskId = await schedule();

    expect(taskId.isDefined).toBe(true);

    const scheduledTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(scheduledTask.isDefined).toBe(true);
    expect(scheduledTask.get.status).toBe(TaskStatus.pending);
    expect(scheduledTask.get.payload).toEqual(payload);
    expect(scheduledTask.get.repeatType.orUndefined).toBe(repeatType);
    expect(scheduledTask.get.startAfter.orUndefined).toEqual(scheduledStart);

    // Run polling before the due time; the task must not start yet.
    await test.tasksQueueService.runOnce();
    expect(startedEventsCount(taskId.get)).toBe(0);

    // Move clock just before the scheduled instant and verify it is still not eligible.
    clock.set(new Date(scheduledStart.getTime() - 1));
    await test.tasksQueueService.runOnce();
    expect(startedEventsCount(taskId.get)).toBe(0);

    // Reload task to verify it remains pending until the exact scheduled time.
    const beforeStartTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(beforeStartTask.isDefined).toBe(true);
    expect(beforeStartTask.get.status).toBe(TaskStatus.pending);
    expect(beforeStartTask.get.payload).toEqual(payload);

    // Advance clock to the scheduled instant and trigger processing.
    clock.set(scheduledStart);
    const runPromise = test.tasksQueueService.runOnce();

    await expect(bus.waitForStarted(taskId.get)).resolves.toEqual({
      type: TestTaskEventType.started,
      taskId: taskId.get,
      payload,
    });

    // Verify that the periodic task is now in progress and attempt counter was incremented.
    const startedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(startedTask.isDefined).toBe(true);
    expect(startedTask.get.status).toBe(TaskStatus.in_progress);
    expect(startedTask.get.attempt).toBe(1);
    expect(startedTask.get.payload).toEqual(payload);
    expect(startedTask.get.result).toBeNull();

    // Complete the run; periodic tasks should reschedule instead of finishing terminally.
    worker.complete(taskId.get, { ok: true });
    await runPromise;

    // Validate that the task returned to pending state with attempts reset and next start computed.
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
