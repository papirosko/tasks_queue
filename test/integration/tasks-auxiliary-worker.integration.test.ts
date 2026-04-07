import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { MetricsService } from "application-metrics";
import { TasksAuxiliaryWorker } from "../../src/tasks-auxiliary-worker.js";
import { TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("TasksAuxiliaryWorker integration", () => {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await test.stop();
  });

  it("processes stalled, failed, and expired finished tasks in one maintenance pass", async () => {
    const retryableFailedTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { kind: "failed" },
      retries: 2,
      timeout: TimeUtils.minute,
    });
    const stalledTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { kind: "stalled" },
      retries: 1,
      timeout: TimeUtils.second,
      backoff: TimeUtils.minute,
    });
    const finishedTaskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload: { kind: "finished" },
    });

    // Prepare one retryable failed row, one terminally stalled row, and one expired finished row.
    await test.db.query(
      `update tasks_queue
          set status = $1,
              attempt = 1,
              error = $2
        where id = $3`,
      [TaskStatus.error, "boom", retryableFailedTaskId.get],
    );
    await test.db.query(
      `update tasks_queue
          set status = $1,
              attempt = 1,
              started = $2
        where id = $3`,
      [
        TaskStatus.in_progress,
        new Date(baseTime.getTime() - TimeUtils.second - 1),
        stalledTaskId.get,
      ],
    );
    await test.db.query(
      `update tasks_queue
          set status = $1,
              finished = $2
        where id = $3`,
      [
        TaskStatus.finished,
        new Date(baseTime.getTime() - TimeUtils.day - 1),
        finishedTaskId.get,
      ],
    );

    const worker = new TasksAuxiliaryWorker(
      test.tasksQueueDao,
      test.manageTasksQueueService,
      clock,
    );

    // Run one maintenance cycle and verify that each housekeeping action mutated the real database.
    await worker.runMaintenanceOnce();

    const retryableFailedTask = await test.manageTasksQueueService.findById(
      retryableFailedTaskId.get,
    );
    const stalledTask = await test.manageTasksQueueService.findById(
      stalledTaskId.get,
    );
    const finishedTask = await test.manageTasksQueueService.findById(
      finishedTaskId.get,
    );

    expect(retryableFailedTask.isDefined).toBe(true);
    expect(retryableFailedTask.get.status).toBe(TaskStatus.pending);
    expect(retryableFailedTask.get.finished.isDefined).toBe(false);

    expect(stalledTask.isDefined).toBe(true);
    expect(stalledTask.get.status).toBe(TaskStatus.error);
    expect(stalledTask.get.error.orUndefined).toBe("Timeout");

    expect(finishedTask.isDefined).toBe(false);
  });

  it("registers gauges from real queue counts using sanitized metric names", async () => {
    await test.tasksQueueService.schedule({
      queue: "preview-jobs",
      payload: { seq: 1 },
    });
    const failedTaskId = await test.tasksQueueService.schedule({
      queue: "preview-jobs",
      payload: { seq: 2 },
      retries: 2,
      timeout: TimeUtils.minute,
    });
    await test.db.query(
      `update tasks_queue
          set status = $1,
              attempt = 1,
              error = $2
        where id = $3`,
      [TaskStatus.error, "boom", failedTaskId.get],
    );

    const gaugeSpy = jest.spyOn(MetricsService, "gauge");
    const worker = new TasksAuxiliaryWorker(
      test.tasksQueueDao,
      test.manageTasksQueueService,
      clock,
    );

    // Sync metrics from the real database and capture registered gauge callbacks.
    await worker.syncMetricsOnce();

    const registeredGauges = new Map<string, () => number>();
    gaugeSpy.mock.calls.forEach(([name, gaugeFactory]) => {
      registeredGauges.set(name as string, gaugeFactory as () => number);
    });
    const pendingGauge = registeredGauges.get(
      "tasks_queue_preview_jobs_pending",
    );
    const errorGauge = registeredGauges.get("tasks_queue_preview_jobs_error");

    expect(registeredGauges.has("tasks_queue_preview_jobs_pending")).toBe(true);
    expect(registeredGauges.has("tasks_queue_preview_jobs_error")).toBe(true);
    expect(pendingGauge === undefined ? undefined : pendingGauge()).toBe(1);
    expect(errorGauge === undefined ? undefined : errorGauge()).toBe(1);
  });
});
