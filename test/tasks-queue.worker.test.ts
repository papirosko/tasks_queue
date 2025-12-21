import { jest } from "@jest/globals";
import { TaskFailed, TaskPeriodType, TaskStatus } from "../src/tasks-model.js";
import { TasksQueueWorker } from "../src/tasks-queue.worker.js";
import { TasksWorker } from "../src/tasks-worker.js";
import type { ScheduledTask } from "../src/tasks-model.js";

jest.mock("application-metrics", () => ({
  MetricsService: {
    counter: jest.fn(() => ({ inc: jest.fn() })),
  },
}));

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
  starting = jest.fn();
  completed = jest.fn(async () => undefined);
  failed = jest.fn(async () => undefined);
}

const createTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 1,
  queue: "q",
  payload: { foo: "bar" },
  currentAttempt: 1,
  maxAttempts: 3,
  ...overrides,
});

describe("TasksQueueWorker", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // Expect successful non-periodic tasks to be marked as finished.
  it("finishes non-periodic tasks after successful processing", async () => {
    const dao = {
      finish: jest.fn(async () => undefined),
      rescheduleIfPeriodic: jest.fn(async () => undefined),
      fail: jest.fn(async () => TaskStatus.pending),
    };
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    worker.registerWorker("q", taskWorker);

    await (worker as any).processNextTask(createTask());

    expect(taskWorker.process).toHaveBeenCalled();
    expect(dao.finish).toHaveBeenCalledWith(1);
    expect(dao.rescheduleIfPeriodic).not.toHaveBeenCalled();
  });

  // Expect periodic tasks to be rescheduled instead of finished.
  it("reschedules periodic tasks after successful processing", async () => {
    const dao = {
      finish: jest.fn(async () => undefined),
      rescheduleIfPeriodic: jest.fn(async () => undefined),
      fail: jest.fn(async () => TaskStatus.pending),
    };
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    worker.registerWorker("q", taskWorker);

    await (worker as any).processNextTask(
      createTask({ repeatType: TaskPeriodType.fixed_rate }),
    );

    expect(dao.rescheduleIfPeriodic).toHaveBeenCalledWith(1);
    expect(dao.finish).not.toHaveBeenCalled();
  });

  // Expect TaskFailed payload to be passed to dao.fail for retry.
  it("stores TaskFailed payloads on retry", async () => {
    const dao = {
      finish: jest.fn(async () => undefined),
      rescheduleIfPeriodic: jest.fn(async () => undefined),
      fail: jest.fn(async () => TaskStatus.pending),
    };
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    taskWorker.process.mockImplementation(async () => {
      throw new TaskFailed("failed", { replace: true });
    });
    worker.registerWorker("q", taskWorker);

    await (worker as any).processNextTask(createTask());

    expect(dao.fail).toHaveBeenCalledWith(
      1,
      "failed",
      { replace: true },
    );
  });

  // Expect lifecycle callback failures to not stop finishing the task.
  it("continues even if lifecycle callbacks throw", async () => {
    const dao = {
      finish: jest.fn(async () => undefined),
      rescheduleIfPeriodic: jest.fn(async () => undefined),
      fail: jest.fn(async () => TaskStatus.pending),
    };
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    taskWorker.completed.mockImplementation(async () => {
      throw new Error("callback failure");
    });
    worker.registerWorker("q", taskWorker);

    await (worker as any).processNextTask(createTask());

    expect(dao.finish).toHaveBeenCalled();
  });

  // Expect missing worker to skip processing and increment metrics.
  it("skips processing when no worker is registered", async () => {
    const { MetricsService } = await import("application-metrics");
    const dao = {
      finish: jest.fn(async () => undefined),
      rescheduleIfPeriodic: jest.fn(async () => undefined),
      fail: jest.fn(async () => TaskStatus.pending),
    };
    const worker = new TasksQueueWorker(dao as any, 1, 10);

    await (worker as any).processNextTask(createTask({ queue: "missing" }));

    expect(MetricsService.counter).toHaveBeenCalledWith(
      "tasks_queue_skipped_no_worker",
    );
  });
});
