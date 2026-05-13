import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { none, some } from "scats";
import { MetricsService } from "application-metrics";
import { TasksQueueWorker } from "../src/tasks-queue.worker.js";
import { TasksWorker } from "../src/tasks-worker.js";
import type { ScheduledTask } from "../src/tasks-model.js";
import { TaskStatus } from "../src/tasks-model.js";
import { TimeUtils } from "../src/time-utils.js";

jest.mock("log4js", () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    error: jest.fn(),
  }),
}));

class TestWorker extends TasksWorker {
  process = jest.fn(async () => undefined);
  completed = jest.fn(async () => undefined);
  failed = jest.fn(async () => undefined);
}

const createTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 1,
  started: new Date(),
  queue: "email",
  payload: { ok: true },
  timeout: TimeUtils.hour,
  currentAttempt: 1,
  maxAttempts: 3,
  ...overrides,
});

const createDao = (overrides: Record<string, any> = {}) => ({
  nextPending: jest.fn(async () => none),
  peekNextStartAfter: jest.fn(async () => none),
  findTaskState: jest.fn(async () => none),
  ping: jest.fn(async () => true),
  finish: jest.fn(async () => true),
  blockParentAndScheduleChild: jest.fn(async () => some(2)),
  rescheduleIfPeriodic: jest.fn(async () => true),
  wakeParentOnChildTerminal: jest.fn(async () => none),
  fail: jest.fn(async () => some(TaskStatus.pending)),
  failIfStalled: jest.fn(async () => none),
  ...overrides,
});

describe("runtime metrics", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("writes a sorted pool queue label and per-queue poll counters", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(
      dao as any,
      1,
      10,
      undefined,
      undefined,
      "runtime_label",
    );
    worker.registerWorker("zeta_label", new TestWorker());
    worker.registerWorker("email_label", new TestWorker());

    await worker.runOnce();
    const metrics = await MetricsService.toJson();

    expect(metrics.labels["tasks_queue_pool_runtime_label_queues"]).toBe(
      "email_label,zeta_label",
    );
    expect(metrics.counters["tasks_queue_queue_email_label_poll_total"]).toBe(
      1,
    );
    expect(metrics.counters["tasks_queue_queue_zeta_label_poll_total"]).toBe(1);
    expect(
      metrics.counters["tasks_queue_queue_email_label_fetched_total"],
    ).toBe(undefined);
  });

  it("increments fetched and successful task lifecycle counters", async () => {
    const task = createTask({ queue: "email_success" });
    const dao = createDao({
      nextPending: jest.fn(async () => some(task)),
    });
    const worker = new TasksQueueWorker(
      dao as any,
      1,
      10,
      undefined,
      undefined,
      "runtime_success",
    );
    worker.registerWorker("email_success", new TestWorker());

    await worker.runOnce();
    const metrics = await MetricsService.toJson();

    expect(metrics.counters["tasks_queue_queue_email_success_poll_total"]).toBe(
      1,
    );
    expect(
      metrics.counters["tasks_queue_queue_email_success_fetched_total"],
    ).toBe(1);
    expect(
      metrics.counters["tasks_queue_queue_email_success_task_started_total"],
    ).toBe(1);
    expect(
      metrics.counters["tasks_queue_queue_email_success_task_finished_total"],
    ).toBe(1);
  });

  it("increments retryable failure lifecycle counters", async () => {
    const task = createTask({ queue: "email_failure" });
    const dao = createDao({
      nextPending: jest.fn(async () => some(task)),
      fail: jest.fn(async () => some(TaskStatus.pending)),
    });
    const taskWorker = new TestWorker();
    taskWorker.process.mockImplementation(async () => {
      throw new Error("boom");
    });
    const worker = new TasksQueueWorker(
      dao as any,
      1,
      10,
      undefined,
      undefined,
      "runtime_failure",
    );
    worker.registerWorker("email_failure", taskWorker);

    await worker.runOnce();
    const metrics = await MetricsService.toJson();

    expect(
      metrics.counters[
        "tasks_queue_queue_email_failure_task_failed_pending_total"
      ],
    ).toBe(1);
  });

  it("increments skipped no-worker counters", async () => {
    const task = createTask({ queue: "missing" });
    const dao = createDao({
      nextPending: jest.fn(async () => some(task)),
    });
    const worker = new TasksQueueWorker(
      dao as any,
      1,
      10,
      undefined,
      undefined,
      "runtime_missing",
    );

    await worker.runOnce();
    const metrics = await MetricsService.toJson();

    expect(
      metrics.counters[
        "tasks_queue_queue_missing_task_skipped_no_worker_total"
      ],
    ).toBe(1);
  });
});
