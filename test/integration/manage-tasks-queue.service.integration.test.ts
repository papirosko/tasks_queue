import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
  BackoffType,
  MissedRunStrategy,
  TaskPeriodType,
  TaskStatus,
} from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("ManageTasksQueueService integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);

  beforeAll(async () => {
    await test.start();
  });

  beforeEach(async () => {
    await test.reset();
    clock.set(baseTime);
  });

  afterAll(async () => {
    await test.stop();
  });

  it("loads task by id with mapped management fields", async () => {
    const startAfter = new Date(baseTime.getTime() + TimeUtils.minute);
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 42 },
      priority: 7,
      retries: 3,
      timeout: TimeUtils.minute * 5,
      backoff: TimeUtils.second * 30,
      backoffType: BackoffType.exponential,
      startAfter,
    });

    expect(taskId.isDefined).toBe(true);

    // Load the management view and verify that optional and runtime fields are mapped correctly.
    const task = await test.manageTasksQueueService.findById(taskId.get);

    expect(task.isDefined).toBe(true);
    expect(task.get.id).toBe(taskId.get);
    expect(task.get.parentId.isDefined).toBe(false);
    expect(task.get.queue).toBe("email");
    expect(task.get.status).toBe(TaskStatus.pending);
    expect(task.get.priority).toBe(7);
    expect(Number(task.get.backoff)).toBe(TimeUtils.second * 30);
    expect(task.get.backoffType).toBe(BackoffType.exponential);
    expect(Number(task.get.timeout)).toBe(TimeUtils.minute * 5);
    expect(Number(task.get.maxAttempts)).toBe(3);
    expect(task.get.attempt).toBe(0);
    expect(task.get.startAfter.orUndefined).toEqual(startAfter);
    expect(task.get.payload).toEqual({ userId: 42 });
    expect(task.get.result).toBeNull();
    expect(task.get.name.isDefined).toBe(false);
    expect(task.get.repeatType.isDefined).toBe(false);
  });

  it("filters tasks by status and queue with pagination ordered by created desc", async () => {
    const firstTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { seq: 1 },
    });
    clock.advance(TimeUtils.second);
    const secondTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { seq: 2 },
    });
    clock.advance(TimeUtils.second);
    await test.tasksQueueService.schedule({
      queue: "video",
      payload: { seq: 3 },
    });

    // Move one task into a different status so filtering exercises both queue and status conditions.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [TaskStatus.finished, clock.now(), firstTaskId.get],
    );

    // Request only pending tasks from the email queue and verify pagination order by creation time.
    const page = await test.manageTasksQueueService.findByParameters({
      status: TaskStatus.pending,
      queue: "email",
      offset: 0,
      limit: 10,
    });

    expect(page.total).toBe("1");
    expect(page.items.map((task) => task.id).toArray).toEqual([secondTaskId.get]);
    expect(page.items.map((task) => task.payload).toArray).toEqual([{ seq: 2 }]);
  });

  it("updates editable runtime fields for pending task", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { version: 1 },
      priority: 1,
      retries: 2,
      timeout: TimeUtils.minute,
      backoff: TimeUtils.second,
      backoffType: BackoffType.linear,
    });
    const updatedStartAfter = new Date(baseTime.getTime() + TimeUtils.minute * 5);

    // Replace the pending task runtime configuration through the management service.
    const updated = await test.manageTasksQueueService.updatePendingTask(taskId.get, {
      startAfter: updatedStartAfter,
      priority: 9,
      timeout: TimeUtils.minute * 10,
      payload: { version: 2, reconfigured: true },
      retries: 4,
      backoff: TimeUtils.second * 15,
      backoffType: BackoffType.constant,
    });

    expect(updated).toBe(true);

    // Reload the row and verify that only management-editable fields changed.
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.pending);
    expect(task.get.startAfter.orUndefined).toEqual(updatedStartAfter);
    expect(task.get.priority).toBe(9);
    expect(Number(task.get.timeout)).toBe(TimeUtils.minute * 10);
    expect(task.get.payload).toEqual({ version: 2, reconfigured: true });
    expect(Number(task.get.maxAttempts)).toBe(4);
    expect(Number(task.get.backoff)).toBe(TimeUtils.second * 15);
    expect(task.get.backoffType).toBe(BackoffType.constant);
  });

  it("rejects invalid pending task runtime configuration before touching the database", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { version: 1 },
      retries: 2,
      timeout: TimeUtils.minute,
      backoff: TimeUtils.second,
      backoffType: BackoffType.linear,
    });

    // Submit an invalid runtime update and verify that validation fails before row contents change.
    await expect(
      test.manageTasksQueueService.updatePendingTask(taskId.get, {
        startAfter: null,
        priority: 5,
        timeout: 0,
        payload: { version: 2 },
        retries: 2,
        backoff: TimeUtils.second,
        backoffType: BackoffType.constant,
      }),
    ).rejects.toThrow("Task timeout must be greater than 0");

    // Reload the row to confirm that rejected management input did not mutate persisted task state.
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(Number(task.get.timeout)).toBe(TimeUtils.minute);
    expect(task.get.payload).toEqual({ version: 1 });
    expect(task.get.priority).toBe(0);
    expect(task.get.backoffType).toBe(BackoffType.linear);
  });

  it("updates periodic schedule fields for pending periodic task", async () => {
    const taskId = await test.tasksQueueService.scheduleAtFixedRate({
      queue: "periodic",
      name: "daily-report",
      period: TimeUtils.minute,
      startAfter: new Date(baseTime.getTime() + TimeUtils.minute),
      payload: { kind: "report" },
    });
    const updatedStartAfter = new Date(baseTime.getTime() + TimeUtils.minute * 10);
    const updatedInitialStart = new Date(baseTime.getTime() + TimeUtils.minute * 3);

    // Replace interval schedule with cron settings through the management API.
    const updated = await test.manageTasksQueueService.updatePendingPeriodicSchedule(
      taskId.get,
      {
        startAfter: updatedStartAfter,
        initialStart: updatedInitialStart,
        repeatType: TaskPeriodType.cron,
        cronExpression: "0 */5 * * * *",
        missedRunStrategy: MissedRunStrategy.catch_up,
      },
    );

    expect(updated).toBe(true);

    // Reload the task and verify that periodic schedule fields were rewritten consistently.
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.pending);
    expect(task.get.startAfter.orUndefined).toEqual(updatedStartAfter);
    expect(task.get.initialStart).toEqual(updatedInitialStart);
    expect(task.get.repeatType.orUndefined).toBe(TaskPeriodType.cron);
    expect(task.get.repeatInterval.orUndefined).toBeUndefined();
    expect(task.get.cronExpression.orUndefined).toBe("0 */5 * * * *");
    expect(task.get.missedRunStrategy).toBe(MissedRunStrategy.catch_up);
  });

  it("rejects invalid pending periodic schedule before updating task row", async () => {
    const taskId = await test.tasksQueueService.scheduleAtFixedRate({
      queue: "periodic",
      name: "invalid-periodic",
      period: TimeUtils.minute,
      startAfter: new Date(baseTime.getTime() + TimeUtils.minute),
      payload: { kind: "report" },
    });

    // Attempt to replace the periodic schedule with an invalid fixed-delay period.
    await expect(
      test.manageTasksQueueService.updatePendingPeriodicSchedule(taskId.get, {
        startAfter: new Date(baseTime.getTime() + TimeUtils.minute * 10),
        initialStart: new Date(baseTime.getTime() + TimeUtils.minute * 2),
        repeatType: TaskPeriodType.fixed_delay,
        period: 0,
        missedRunStrategy: MissedRunStrategy.skip_missed,
      }),
    ).rejects.toThrow("Periodic task period must be greater than 0");

    // Confirm that rejected schedule input left the previously stored periodic configuration intact.
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.repeatType.orUndefined).toBe(TaskPeriodType.fixed_rate);
    expect(Number(task.get.repeatInterval.orUndefined)).toBe(TimeUtils.minute);
    expect(task.get.cronExpression.orUndefined).toBeUndefined();
    expect(task.get.missedRunStrategy).toBe(MissedRunStrategy.skip_missed);
  });

  it("deletes finished root task and keeps in-progress or ancestor-protected tasks", async () => {
    const deletableTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { kind: "finished-root" },
    });
    const runningTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { kind: "running-root" },
    });
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { kind: "parent" },
      retries: 1,
    });

    // Prepare one safely deletable root task and one actively running task.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [TaskStatus.finished, clock.now(), deletableTaskId.get],
    );
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2,
              attempt = 1
        where id = $3`,
      [TaskStatus.in_progress, clock.now(), runningTaskId.get],
    );

    // Create a finished child with a blocked ancestor; management delete must preserve it.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2,
              attempt = 1
        where id = $3`,
      [TaskStatus.in_progress, clock.now(), parentTaskId.get],
    );
    const protectedChildId = await test.tasksQueueDao.blockParentAndScheduleChild(
      parentTaskId.get,
      {
        queue: "email-child",
        payload: { kind: "child" },
      },
      {
        workflowPayload: { step: "child" },
        userPayload: { userId: 42 },
      },
      clock.now(),
      clock.now(),
    );
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [TaskStatus.finished, clock.now(), protectedChildId.get],
    );

    // Delete operations should remove only the safe finished root task.
    await expect(
      test.manageTasksQueueService.deleteTask(deletableTaskId.get),
    ).resolves.toBe(true);
    await expect(
      test.manageTasksQueueService.deleteTask(runningTaskId.get),
    ).resolves.toBe(false);
    await expect(
      test.manageTasksQueueService.deleteTask(protectedChildId.get),
    ).resolves.toBe(false);

    const deletableTask = await test.manageTasksQueueService.findById(
      deletableTaskId.get,
    );
    const runningTask = await test.manageTasksQueueService.findById(
      runningTaskId.get,
    );
    const protectedChild = await test.manageTasksQueueService.findById(
      protectedChildId.get,
    );
    expect(deletableTask.isDefined).toBe(false);
    expect(runningTask.isDefined).toBe(true);
    expect(runningTask.get.status).toBe(TaskStatus.in_progress);
    expect(protectedChild.isDefined).toBe(true);
    expect(protectedChild.get.status).toBe(TaskStatus.finished);
  });

  it("restarts one failed task without touching unrelated failed rows", async () => {
    const firstTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { seq: 1 },
    });
    const secondTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { seq: 2 },
    });

    // Prepare two failed tasks so restartFailedTask can target only one of them.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              attempt = 2,
              error = $2
        where id in ($3, $4)`,
      [TaskStatus.error, "boom", firstTaskId.get, secondTaskId.get],
    );

    // Restart only the selected failed task and keep the other one unchanged.
    await test.manageTasksQueueService.restartFailedTask(firstTaskId.get);

    const firstTask = await test.manageTasksQueueService.findById(firstTaskId.get);
    const secondTask = await test.manageTasksQueueService.findById(secondTaskId.get);
    expect(firstTask.isDefined).toBe(true);
    expect(firstTask.get.status).toBe(TaskStatus.pending);
    expect(firstTask.get.attempt).toBe(0);
    expect(secondTask.isDefined).toBe(true);
    expect(secondTask.get.status).toBe(TaskStatus.error);
    expect(secondTask.get.attempt).toBe(2);
  });

  it("restarts all failed tasks in selected queue", async () => {
    const emailTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { scope: "email" },
    });
    const videoTaskId = await test.tasksQueueService.schedule({
      queue: "video",
      payload: { scope: "video" },
    });

    // Put failed tasks into two different queues so queue-scoped restart can be observed clearly.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              attempt = 3,
              error = $2
        where id in ($3, $4)`,
      [TaskStatus.error, "boom", emailTaskId.get, videoTaskId.get],
    );

    // Restart all failed tasks only in the email queue.
    await test.manageTasksQueueService.restartAllFailedInQueue("email");

    const emailTask = await test.manageTasksQueueService.findById(emailTaskId.get);
    const videoTask = await test.manageTasksQueueService.findById(videoTaskId.get);
    expect(emailTask.isDefined).toBe(true);
    expect(emailTask.get.status).toBe(TaskStatus.pending);
    expect(emailTask.get.attempt).toBe(0);
    expect(videoTask.isDefined).toBe(true);
    expect(videoTask.get.status).toBe(TaskStatus.error);
    expect(videoTask.get.attempt).toBe(3);
  });

  it("counts failed tasks and clears them from the queue", async () => {
    const failedTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { seq: 1 },
    });
    await test.tasksQueueService.schedule({
      queue: "email",
      payload: { seq: 2 },
    });

    // Create one failed row and keep one non-failed row to verify count and delete behavior.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              error = $2
        where id = $3`,
      [TaskStatus.error, "boom", failedTaskId.get],
    );

    expect(await test.manageTasksQueueService.failedCount()).toBe("1");

    // Clear failed tasks and confirm only error rows were removed.
    await test.manageTasksQueueService.clearFailed();

    expect(await test.manageTasksQueueService.failedCount()).toBe("0");
    const remaining = await test.manageTasksQueueService.findByParameters({
      offset: 0,
      limit: 10,
    });
    expect(remaining.total).toBe("1");
    expect(remaining.items.map((task) => task.status).toArray).toEqual([
      TaskStatus.pending,
    ]);
  });

  it("returns queue counts and wait/work time statistics grouped by queue", async () => {
    // Seed two tasks in the same queue with deterministic wait and work durations.
    await test.db.query(
      `insert into tasks_queue (
          queue, created, initial_start, started, finished, status, attempt
        ) values ($1, $2, $2, $3, $4, $5, $6)`,
      [
        "email",
        new Date("2026-04-07T10:00:00.000Z"),
        new Date("2026-04-07T10:00:10.000Z"),
        new Date("2026-04-07T10:00:30.000Z"),
        TaskStatus.finished,
        1,
      ],
    );
    await test.db.query(
      `insert into tasks_queue (
          queue, created, initial_start, started, finished, status, attempt
        ) values ($1, $2, $2, $3, $4, $5, $6)`,
      [
        "email",
        new Date("2026-04-07T10:02:00.000Z"),
        new Date("2026-04-07T10:02:20.000Z"),
        new Date("2026-04-07T10:03:20.000Z"),
        TaskStatus.finished,
        1,
      ],
    );
    await test.db.query(
      `insert into tasks_queue (
          queue, created, initial_start, status, attempt
        ) values ($1, $2, $2, $3, 0)`,
      [
        "video",
        new Date("2026-04-07T10:04:00.000Z"),
        TaskStatus.pending,
      ],
    );

    // Fetch management counters and latency stats to verify queue grouping and numeric mapping.
    const counts = await test.manageTasksQueueService.tasksCount();
    const waitStats = await test.manageTasksQueueService.waitTimeByQueue();
    const workStats = await test.manageTasksQueueService.workTimeByQueue();

    expect(counts.map((row) => [row.queueName, row.status, row.count]).toArray).toEqual([
      ["email", TaskStatus.finished, 2],
      ["video", TaskStatus.pending, 1],
    ]);
    expect(waitStats.map((row) => [row.queueName, row.p50, row.p95]).toArray).toEqual([
      ["email", 10, 20],
    ]);
    expect(workStats.map((row) => [row.queueName, row.p50, row.p95]).toArray).toEqual([
      ["email", 20, 60],
    ]);
  });
});
