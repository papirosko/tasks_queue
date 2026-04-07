import { afterEach, jest } from "@jest/globals";
import { none, some } from "scats";
import {
  TASK_HEARTBEAT_THROTTLE_MS,
  TaskContext,
  TaskFailed,
  TaskPeriodType,
  TaskStatus,
} from "../src/tasks-model.js";
import { TasksQueueWorker } from "../src/tasks-queue.worker.js";
import { TasksWorker } from "../src/tasks-worker.js";
import type { ScheduledTask } from "../src/tasks-model.js";
import { Clock } from "../src/clock.js";
import { TimeUtils } from "../src/time-utils.js";

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
  started: new Date(),
  queue: "q",
  payload: { foo: "bar" },
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

describe("TasksQueueWorker", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // Expect successful non-periodic tasks to be marked as finished.
  it("finishes non-periodic tasks after successful processing", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(taskWorker.process).toHaveBeenCalled();
    expect(dao.finish).toHaveBeenCalledWith(
      1,
      { foo: "bar" },
      undefined,
      task.started,
      expect.any(Date),
    );
    expect(dao.rescheduleIfPeriodic).not.toHaveBeenCalled();
  });

  // Expect periodic tasks to be rescheduled instead of finished.
  it("reschedules periodic tasks after successful processing", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    worker.registerWorker("q", taskWorker);
    const task = createTask({ repeatType: TaskPeriodType.fixed_rate });

    await (worker as any).processNextTask(task);

    expect(dao.rescheduleIfPeriodic).toHaveBeenCalledWith(
      1,
      { foo: "bar" },
      undefined,
      task.started,
      expect.any(Date),
    );
    expect(dao.finish).not.toHaveBeenCalled();
  });

  // Expect TaskFailed payload to be passed to dao.fail for retry.
  it("stores TaskFailed payloads on retry", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    taskWorker.process.mockImplementation(async () => {
      throw new TaskFailed("failed", { replace: true });
    });
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.fail).toHaveBeenCalledWith(
      1,
      "failed",
      { replace: true },
      undefined,
      task.started,
      expect.any(Date),
    );
  });

  it("persists submitted result on successful completion", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    (taskWorker.process as any).mockImplementation(
      async (_payload: any, context: TaskContext) => {
        context.submitResult({ ok: true });
      },
    );
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.finish).toHaveBeenCalledWith(
      1,
      { foo: "bar" },
      { ok: true },
      task.started,
      expect.any(Date),
    );
  });

  it("passes submitted result into terminal failure flow", async () => {
    const dao = createDao({
      fail: jest.fn(async () => some(TaskStatus.error)),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    (taskWorker.process as any).mockImplementation(
      async (_payload: any, context: TaskContext) => {
        context.submitResult({ partial: true });
        throw new Error("boom");
      },
    );
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.fail).toHaveBeenCalledWith(
      1,
      "boom",
      { foo: "bar" },
      { partial: true },
      task.started,
      expect.any(Date),
    );
  });

  // Expect lifecycle callback failures to not stop finishing the task.
  it("continues even if lifecycle callbacks throw", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    taskWorker.completed.mockImplementation(async () => {
      throw new Error("callback failure");
    });
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.finish).toHaveBeenCalled();
  });

  // Expect missing worker to skip processing and increment metrics.
  it("skips processing when no worker is registered", async () => {
    const { MetricsService } = await import("application-metrics");
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);

    await (worker as any).processNextTask(createTask({ queue: "missing" }));

    expect(MetricsService.counter).toHaveBeenCalledWith(
      "tasks_queue_skipped_no_worker",
    );
  });

  it("blocks parent and schedules child when process requests spawnChild", async () => {
    const dao = createDao({
      blockParentAndScheduleChild: jest.fn(async () => some(2)),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    (taskWorker.process as any).mockImplementation(
      async (_payload: any, context: TaskContext) => {
        context.spawnChild({ queue: "child-q", payload: { child: true } });
      },
    );
    worker.registerWorker("q", taskWorker);
    worker.registerWorker("child-q", new TestWorker());
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.blockParentAndScheduleChild).toHaveBeenCalledWith(
      1,
      {
        queue: "child-q",
        payload: { child: true },
      },
      { foo: "bar" },
      task.started,
      expect.any(Date),
    );
    expect(dao.finish).not.toHaveBeenCalled();
  });

  it("wakes blocked parent after child finishes successfully", async () => {
    const dao = createDao({
      wakeParentOnChildTerminal: jest.fn(async () =>
        some({ id: 99, queue: "parent-q" }),
      ),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    worker.registerWorker("q", new TestWorker());
    worker.registerWorker("parent-q", new TestWorker());
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.wakeParentOnChildTerminal).toHaveBeenCalledWith(
      1,
      expect.any(Date),
    );
  });

  it("wakes blocked parent only on terminal child failure", async () => {
    const dao = createDao({
      fail: jest.fn(async () => some(TaskStatus.error)),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    taskWorker.process.mockImplementation(async () => {
      throw new Error("boom");
    });
    worker.registerWorker("q", taskWorker);

    await (worker as any).processNextTask(createTask());

    expect(dao.wakeParentOnChildTerminal).toHaveBeenCalledWith(
      1,
      expect.any(Date),
    );
  });

  it("provides context.ping() that writes heartbeat for the current task", async () => {
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    (taskWorker.process as any).mockImplementation(
      async (_payload: any, context: TaskContext) => {
        await context.ping();
      },
    );
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.ping).toHaveBeenCalledWith(
      1,
      task.started,
      expect.any(Date),
    );
  });

  it("throttles repeated context.ping() calls in runtime", async () => {
    const t0 = 1_000;
    const t1 = 1_000 + TASK_HEARTBEAT_THROTTLE_MS - 1;
    const t2 = 1_000 + TASK_HEARTBEAT_THROTTLE_MS + 1;
    const nowValues = [t0, t0, t0, t0, t1, t1, t2, t2, t2];
    const clock: Clock = {
      now: jest.fn(() => new Date(nowValues.shift() ?? 0)),
    };
    const dao = createDao();
    const worker = new TasksQueueWorker(dao as any, 1, 10, clock);
    const taskWorker = new TestWorker();
    (taskWorker.process as any).mockImplementation(
      async (_payload: any, context: TaskContext) => {
        await context.ping();
        await context.ping();
        await context.ping();
      },
    );
    worker.registerWorker("q", taskWorker);

    await (worker as any).processNextTask(createTask());

    expect(dao.ping).toHaveBeenCalledTimes(2);
  });

  it("fails the task when process returns after the timeout window", async () => {
    const nowValues = [new Date(TimeUtils.second + 1)];
    const clock: Clock = {
      now: () => nowValues.shift() ?? new Date(TimeUtils.second + 1),
    };
    const dao = createDao({
      failIfStalled: jest.fn(async () => some(TaskStatus.error)),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10, clock);
    const taskWorker = new TestWorker();
    worker.registerWorker("q", taskWorker);
    const task = createTask({ timeout: TimeUtils.second, started: new Date(0) });

    await (worker as any).processNextTask(task);

    expect(dao.failIfStalled).toHaveBeenCalledWith(
      1,
      task.started,
      new Date(TimeUtils.second + 1),
    );
    expect(dao.finish).not.toHaveBeenCalled();
    expect(taskWorker.completed).not.toHaveBeenCalled();
    expect(taskWorker.failed).toHaveBeenCalledWith(
      1,
      { foo: "bar" },
      TaskStatus.error,
      expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
    );
    expect(dao.fail).not.toHaveBeenCalled();
  });

  it("throws from context.ping when the task is already stalled", async () => {
    const nowValues = [new Date(TimeUtils.second + 1)];
    const clock: Clock = {
      now: () => nowValues.shift() ?? new Date(TimeUtils.second + 1),
    };
    const dao = createDao({
      failIfStalled: jest.fn(async () => some(TaskStatus.error)),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10, clock);
    const taskWorker = new TestWorker();
    (taskWorker.process as any).mockImplementation(
      async (_payload: any, context: TaskContext) => {
        await context.ping();
      },
    );
    worker.registerWorker("q", taskWorker);
    const task = createTask({ timeout: TimeUtils.second, started: new Date(0) });

    await (worker as any).processNextTask(task);

    expect(dao.failIfStalled).toHaveBeenCalledWith(
      1,
      task.started,
      new Date(TimeUtils.second + 1),
    );
    expect(dao.ping).not.toHaveBeenCalled();
    expect(taskWorker.failed).toHaveBeenCalledWith(
      1,
      { foo: "bar" },
      TaskStatus.error,
      expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
    );
    expect(dao.fail).not.toHaveBeenCalled();
  });

  it("does not invoke completed callback when finish loses ownership by started timestamp", async () => {
    const dao = createDao({
      finish: jest.fn(async () => false),
    });
    const worker = new TasksQueueWorker(dao as any, 1, 10);
    const taskWorker = new TestWorker();
    worker.registerWorker("q", taskWorker);
    const task = createTask();

    await (worker as any).processNextTask(task);

    expect(dao.finish).toHaveBeenCalledWith(
      1,
      { foo: "bar" },
      undefined,
      task.started,
      expect.any(Date),
    );
    expect(taskWorker.completed).not.toHaveBeenCalled();
    expect(taskWorker.failed).not.toHaveBeenCalled();
  });
});
