import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("TasksQueueService integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);

  beforeAll(async () => {
    await test.start();
  });

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    await test.reset();
    clock.set(baseTime);
  });

  it("creates a task row in postgres", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 42, action: "send" },
      priority: 7,
    });

    expect(taskId.isDefined).toBe(true);

    // Load the stored row from Postgres and verify that schedule() persisted all key fields.
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

  it("requeues stalled task back to pending when retries remain", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 42, action: "send" },
      retries: 2,
      timeout: TimeUtils.second,
      backoff: TimeUtils.second * 5,
    });

    // Put the task into a running state so DAO timeout detection can evaluate it.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              attempt = 1,
              started = $2
        where id = $3`,
      [TaskStatus.in_progress, clock.now(), taskId.get],
    );

    // Move past the timeout and verify that the stalled task is requeued for retry.
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());

    expect(stalled.toArray).toEqual([taskId.get]);

    // Reload the task and confirm that timeout metadata was stored together with the retry schedule.
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.pending);
    expect(task.get.error.orUndefined).toBe("Timeout");
    expect(task.get.finished.orUndefined).toEqual(clock.now());
    expect(task.get.startAfter.orUndefined).toEqual(
      new Date(clock.now().getTime() + TimeUtils.second * 5),
    );
  });

  it("clears expired finished root task", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 7 },
    });

    // Mark the task as finished long enough ago to satisfy cleanup retention rules.
    const finishedAt = new Date(clock.now().getTime() - TimeUtils.day - 1);
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [TaskStatus.finished, finishedAt, taskId.get],
    );

    // Expired finished root tasks should be removed by DAO cleanup.
    await test.tasksQueueDao.clearFinished(TimeUtils.day, clock.now());

    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(false);
  });

  it("does not clear finished child task until parent is finished", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { workflow: "parent" },
      retries: 1,
    });

    // Emulate an actively running parent before it blocks on a spawned child.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2,
              attempt = 1
        where id = $3`,
      [TaskStatus.in_progress, clock.now(), parentTaskId.get],
    );

    // Block the parent and create a real child row via DAO orchestration.
    const childTaskId = await test.tasksQueueDao.blockParentAndScheduleChild(
      parentTaskId.get,
      {
        queue: "email-child",
        payload: { workflow: "child" },
      },
      {
        workflowPayload: { step: "child" },
        userPayload: { userId: 42 },
      },
      clock.now(),
      clock.now(),
    );

    // Make the child look like an old finished task that would normally be eligible for cleanup.
    const finishedAt = new Date(clock.now().getTime() - TimeUtils.day - 1);
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [TaskStatus.finished, finishedAt, childTaskId.get],
    );

    // Cleanup must preserve the child because its parent is still blocked, not finished.
    await test.tasksQueueDao.clearFinished(TimeUtils.day, clock.now());

    const childWhileParentBlocked = await test.manageTasksQueueService.findById(
      childTaskId.get,
    );
    expect(childWhileParentBlocked.isDefined).toBe(true);
    expect(childWhileParentBlocked.get.status).toBe(TaskStatus.finished);

    // Once the parent is also finished and expired, both rows become removable.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [TaskStatus.finished, finishedAt, parentTaskId.get],
    );

    await test.tasksQueueDao.clearFinished(TimeUtils.day, clock.now());

    const parentAfterCleanup = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    const childAfterCleanup = await test.manageTasksQueueService.findById(
      childTaskId.get,
    );
    expect(parentAfterCleanup.isDefined).toBe(false);
    expect(childAfterCleanup.isDefined).toBe(false);
  });

  it("does not update heartbeat when started timestamp belongs to another attempt", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 1 },
      timeout: TimeUtils.minute,
    });

    const actualStarted = new Date(clock.now().getTime() + TimeUtils.second);
    const staleStarted = clock.now();
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2
        where id = $3`,
      [TaskStatus.in_progress, actualStarted, taskId.get],
    );

    const updated = await test.tasksQueueDao.ping(
      taskId.get,
      staleStarted,
      new Date(actualStarted.getTime() + TimeUtils.second),
    );

    expect(updated).toBe(false);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.in_progress);
    expect(task.get.started.orUndefined).toEqual(actualStarted);
    const row = await test.db.query(
      `select last_heartbeat
         from tasks_queue
        where id = $1`,
      [taskId.get],
    );
    expect(row.rows[0]["last_heartbeat"]).toBeNull();
  });

  it("does not finish task when started timestamp belongs to another attempt", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 2 },
    });

    const actualStarted = new Date(clock.now().getTime() + TimeUtils.second);
    const staleStarted = clock.now();
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2
        where id = $3`,
      [TaskStatus.in_progress, actualStarted, taskId.get],
    );

    const finished = await test.tasksQueueDao.finish(
      taskId.get,
      { userId: 2, stale: true },
      { ok: true },
      staleStarted,
      new Date(actualStarted.getTime() + TimeUtils.second),
    );

    expect(finished).toBe(false);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.in_progress);
    expect(task.get.payload).toEqual({ userId: 2 });
    expect(task.get.result).toBeNull();
  });

  it("does not fail task when started timestamp belongs to another attempt", async () => {
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { userId: 3 },
      retries: 2,
      backoff: TimeUtils.minute,
    });

    const actualStarted = new Date(clock.now().getTime() + TimeUtils.second);
    const staleStarted = clock.now();
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2,
              attempt = 1
        where id = $3`,
      [TaskStatus.in_progress, actualStarted, taskId.get],
    );

    const failed = await test.tasksQueueDao.fail(
      taskId.get,
      "boom",
      { stale: true },
      { partial: true },
      staleStarted,
      new Date(actualStarted.getTime() + TimeUtils.second),
    );

    expect(failed.isDefined).toBe(false);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.in_progress);
    expect(task.get.error.orUndefined).toBeUndefined();
    expect(task.get.payload).toEqual({ userId: 3 });
    expect(task.get.result).toBeNull();
  });

  it("does not reschedule periodic task when started timestamp belongs to another attempt", async () => {
    const taskId = await test.tasksQueueService.scheduleAtFixedRate({
      queue: "email",
      name: "dao-periodic-mm",
      period: TimeUtils.minute,
      startAfter: clock.now(),
      payload: { userId: 4 },
    });

    const actualStarted = new Date(clock.now().getTime() + TimeUtils.second);
    const staleStarted = clock.now();
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2,
              attempt = 1
        where id = $3`,
      [TaskStatus.in_progress, actualStarted, taskId.get],
    );

    const rescheduled = await test.tasksQueueDao.rescheduleIfPeriodic(
      taskId.get,
      { userId: 4, stale: true },
      { ok: true },
      staleStarted,
      new Date(actualStarted.getTime() + TimeUtils.second),
    );

    expect(rescheduled).toBe(false);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.in_progress);
    expect(task.get.payload).toEqual({ userId: 4 });
    expect(task.get.result).toBeNull();
    expect(task.get.startAfter.orUndefined).toEqual(clock.now());
  });

  it("does not block parent or create child when started timestamp belongs to another attempt", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { workflow: "parent" },
    });

    const actualStarted = new Date(clock.now().getTime() + TimeUtils.second);
    const staleStarted = clock.now();
    await test.db.query(
      `update tasks_queue
          set status = $1,
              started = $2,
              attempt = 1
        where id = $3`,
      [TaskStatus.in_progress, actualStarted, parentTaskId.get],
    );

    const childTaskId = await test.tasksQueueDao.blockParentAndScheduleChild(
      parentTaskId.get,
      {
        queue: "email-child",
        payload: { workflow: "child" },
      },
      {
        workflowPayload: { step: "child" },
        userPayload: { userId: 42 },
      },
      staleStarted,
      new Date(actualStarted.getTime() + TimeUtils.second),
    );

    expect(childTaskId.isDefined).toBe(false);
    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.in_progress);
    const children = await test.db.query(
      `select id
         from tasks_queue
        where parent_id = $1`,
      [parentTaskId.get],
    );
    expect(children.rows).toHaveLength(0);
  });
});
