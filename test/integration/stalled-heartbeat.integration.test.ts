import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { mutable } from "scats";
import { TaskContext, TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";
import { TestTaskEventType, TestTaskEventsBus } from "./support/task-events-bus.js";
import { TasksWorker } from "../../src/tasks-worker.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

class HeartbeatControlledWorker extends TasksWorker {
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
    this.bus.emitCompleted(taskId);
  }

  override async failed(
    taskId: number,
    _payload: any,
    _finalStatus: TaskStatus,
    error: any,
  ): Promise<void> {
    this.bus.emitFailed(taskId, String(error?.message ?? error));
  }

  async ping(taskId: number, occurrence: number = 1): Promise<void> {
    await this.execution(taskId, occurrence).context.ping();
  }

  complete(taskId: number, occurrence: number = 1, result?: object): void {
    const execution = this.execution(taskId, occurrence);
    if (result !== undefined) {
      execution.context.submitResult(result);
    }
    execution.deferred.resolve();
  }

  fail(taskId: number, error: Error, occurrence: number = 1): void {
    this.execution(taskId, occurrence).deferred.reject(error);
  }

  reset(): void {
    this.executions.clear();
  }

  private execution(taskId: number, occurrence: number) {
    return this.executions.get(taskId).get.get(occurrence - 1);
  }
}

describe("Stalled heartbeat integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const worker = new HeartbeatControlledWorker(bus);

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

  it("marks in-progress task as stalled after timeout without heartbeat", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
      timeout: TimeUtils.second,
    });

    // Start the task and leave it running without any heartbeat updates.
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    // Move clock past timeout and ask DAO to detect stalled tasks.
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());

    // Confirm that the running task was marked as timed out in persistent storage.
    expect(stalled.toArray).toEqual([taskId.get]);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.error);
    expect(task.get.error.orUndefined).toBe("Timeout");
    expect(task.get.payload).toEqual(payload);
  });

  it("does not stall task when heartbeat was refreshed in time", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
      timeout: TimeUtils.second,
    });

    // Start the task and refresh its heartbeat before the timeout threshold.
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    clock.advance(TimeUtils.second - 100);
    await worker.ping(taskId.get);

    // Move slightly forward and verify that the refreshed heartbeat prevents stalling.
    clock.advance(200);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());

    expect(stalled.toArray).toEqual([]);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.in_progress);
    expect(task.get.payload).toEqual(payload);
  });

  it("throws from ping when the current attempt is already stalled", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
      timeout: TimeUtils.second,
    });

    // Start the task, let it outlive the timeout window, then verify that heartbeat is rejected.
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    clock.advance(TimeUtils.second + 1);
    await expect(worker.ping(taskId.get)).rejects.toThrow(
      `Task ${taskId.get} timed out`,
    );

    // The failed ping should also persist timeout failure state immediately.
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.error);
    expect(task.get.error.orUndefined).toBe("Timeout");
  });

  it("does not let a stale attempt heartbeat or complete the retried task", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 2,
      timeout: TimeUtils.second,
      backoff: 0,
    });

    // Start the first attempt and keep it running while timeout handling moves the task back to pending.
    const firstRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 1);
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());
    expect(stalled.toArray).toEqual([taskId.get]);

    // Start the retry attempt; it now owns the task row with a different started timestamp.
    const secondRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 2);
    const rowBeforeStaleActions = await test.db.query(
      `select started, last_heartbeat
         from tasks_queue
        where id = $1`,
      [taskId.get],
    );
    const secondStarted = new Date(rowBeforeStaleActions.rows[0]["started"]);
    expect(rowBeforeStaleActions.rows[0]["last_heartbeat"]).toBeNull();

    // Old context must not heartbeat the new attempt.
    await expect(worker.ping(taskId.get, 1)).rejects.toThrow(
      `Task ${taskId.get} timed out`,
    );
    const rowAfterStalePing = await test.db.query(
      `select status, started, last_heartbeat, result
         from tasks_queue
        where id = $1`,
      [taskId.get],
    );
    expect(rowAfterStalePing.rows[0]["status"]).toBe(TaskStatus.in_progress);
    expect(new Date(rowAfterStalePing.rows[0]["started"])).toEqual(secondStarted);
    expect(rowAfterStalePing.rows[0]["last_heartbeat"]).toBeNull();
    expect(rowAfterStalePing.rows[0]["result"]).toBeNull();

    // Old context may finish locally, but it must not resolve the retried attempt in storage.
    worker.complete(taskId.get, 1, { stale: true });
    await firstRun;
    const taskAfterStaleComplete = await test.manageTasksQueueService.findById(
      taskId.get,
    );
    expect(taskAfterStaleComplete.isDefined).toBe(true);
    expect(taskAfterStaleComplete.get.status).toBe(TaskStatus.in_progress);
    expect(taskAfterStaleComplete.get.result).toBeNull();

    // The current retry attempt still owns the row and can finish normally.
    worker.complete(taskId.get, 2, { fresh: true });
    await secondRun;
    const finishedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(finishedTask.isDefined).toBe(true);
    expect(finishedTask.get.status).toBe(TaskStatus.finished);
    expect(finishedTask.get.result).toEqual({ fresh: true });
    expect(
      bus
        .events(taskId.get)
        .count((event) => event.type === TestTaskEventType.completed),
    ).toBe(1);
  });

  it("does not let a stale attempt fail the retried task", async () => {
    const payload = { userId: 43 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 2,
      timeout: TimeUtils.second,
      backoff: 0,
    });

    // First attempt stalls and is re-queued immediately for retry.
    const firstRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 1);
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());
    expect(stalled.toArray).toEqual([taskId.get]);

    // Second attempt starts and owns the task row.
    const secondRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get, 2);
    const rowBeforeStaleFailure = await test.db.query(
      `select status, started, error, result
         from tasks_queue
        where id = $1`,
      [taskId.get],
    );
    const secondStarted = new Date(rowBeforeStaleFailure.rows[0]["started"]);
    expect(rowBeforeStaleFailure.rows[0]["status"]).toBe(TaskStatus.in_progress);
    expect(rowBeforeStaleFailure.rows[0]["error"]).toBe("Timeout");
    expect(rowBeforeStaleFailure.rows[0]["result"]).toBeNull();

    // Old context may fail locally, but it must not move the new attempt out of in-progress.
    worker.fail(taskId.get, new Error("stale boom"), 1);
    await bus.waitForFailed(taskId.get, 1);
    await firstRun;

    const rowAfterStaleFailure = await test.db.query(
      `select status, started, error, result
         from tasks_queue
        where id = $1`,
      [taskId.get],
    );
    expect(rowAfterStaleFailure.rows[0]["status"]).toBe(TaskStatus.in_progress);
    expect(new Date(rowAfterStaleFailure.rows[0]["started"])).toEqual(
      secondStarted,
    );
    expect(rowAfterStaleFailure.rows[0]["error"]).toBe("Timeout");
    expect(rowAfterStaleFailure.rows[0]["result"]).toBeNull();

    // The current retry attempt still owns the row and can finish normally.
    worker.complete(taskId.get, 2, { fresh: true });
    await secondRun;

    const finishedTask = await test.manageTasksQueueService.findById(taskId.get);
    expect(finishedTask.isDefined).toBe(true);
    expect(finishedTask.get.status).toBe(TaskStatus.finished);
    expect(finishedTask.get.result).toEqual({ fresh: true });

    expect(
      bus
        .events(taskId.get)
        .count((event) => event.type === TestTaskEventType.failed),
    ).toBe(1);
    expect(
      bus
        .events(taskId.get)
        .count((event) => event.type === TestTaskEventType.completed),
    ).toBe(1);
  });
});
