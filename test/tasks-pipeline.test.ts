import { afterEach, beforeEach, jest } from "@jest/globals";
import { none, some } from "scats";
import { TasksPipeline } from "../src/tasks-pipeline.js";
import type { ScheduledTask } from "../src/tasks-model.js";
import { MetricsService } from "application-metrics";

const createTask = (id: number): ScheduledTask => ({
  id,
  started: new Date(),
  queue: "q",
  payload: { id },
  timeout: 60_000,
  currentAttempt: 1,
  maxAttempts: 3,
});

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("TasksPipeline", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(0));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // Expect start() to kick off polling, so pollNextTask should be invoked.
  it("starts polling when started", async () => {
    const pollNextTask = jest.fn(async () => none);
    const peekNextStartAfter = jest.fn(async () => none);
    const processTask = jest.fn(async () => undefined);
    const pipeline = new TasksPipeline(
      1,
      pollNextTask,
      peekNextStartAfter,
      processTask,
      10,
      undefined,
      "pipeline_start",
    );

    pipeline.start();
    await jest.advanceTimersByTimeAsync(1);
    await jest.runOnlyPendingTimersAsync();

    expect(pollNextTask).toHaveBeenCalled();
    await pipeline.stop();
  });

  // Expect only one task to run at a time when max concurrency is 1.
  it("respects max concurrent tasks before fetching more", async () => {
    const deferred = createDeferred<void>();
    let pollCount = 0;
    const pollNextTask = jest.fn(async () => {
      pollCount += 1;
      return pollCount === 1 ? some(createTask(1)) : none;
    });
    const peekNextStartAfter = jest.fn(async () => none);
    const processTask = jest.fn(async () => deferred.promise);
    const pipeline = new TasksPipeline(
      1,
      pollNextTask,
      peekNextStartAfter,
      processTask,
      10,
      undefined,
      "pipeline_concurrency",
    );

    const immediateSpy = jest
      .spyOn(global, "setImmediate")
      .mockImplementation((cb: (...args: any[]) => void) => {
        cb();
        return 0 as any;
      });

    await (pipeline as any).loop();

    expect(processTask).toHaveBeenCalledTimes(1);
    expect(pollNextTask).toHaveBeenCalledTimes(1);
    expect((pipeline as any).tasksInProcess).toBe(1);

    deferred.resolve();
    await deferred.promise;
    await Promise.resolve();

    expect((pipeline as any).tasksInProcess).toBe(0);
    immediateSpy.mockRestore();
    await pipeline.stop();
  });

  // Expect the sleep delay to match the nearest start_after timestamp.
  it("uses peekNextStartAfter to reduce sleep interval", async () => {
    const pollNextTask = jest.fn(async () => none);
    const peekNextStartAfter = jest.fn(async () =>
      some(new Date(Date.now() + 5)),
    );
    const processTask = jest.fn(async () => undefined);
    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const pipeline = new TasksPipeline(
      1,
      pollNextTask,
      peekNextStartAfter,
      processTask,
      100,
      undefined,
      "pipeline_peek",
    );

    pipeline.start();
    await jest.advanceTimersByTimeAsync(1);
    await jest.runOnlyPendingTimersAsync();

    const hasShortSleep = timeoutSpy.mock.calls.some((call) => call[1] === 5);
    expect(hasShortSleep).toBe(true);

    timeoutSpy.mockRestore();
    await pipeline.stop();
  });

  // Expect triggerLoop() to schedule a poll when the loop is idle.
  it("triggerLoop schedules an immediate polling cycle", async () => {
    const pollNextTask = jest.fn(async () => none);
    const peekNextStartAfter = jest.fn(async () => none);
    const processTask = jest.fn(async () => undefined);
    const pipeline = new TasksPipeline(
      1,
      pollNextTask,
      peekNextStartAfter,
      processTask,
      100,
      undefined,
      "pipeline_trigger",
    );

    pipeline.triggerLoop();
    await jest.advanceTimersByTimeAsync(1);
    await jest.runOnlyPendingTimersAsync();

    expect(pollNextTask).toHaveBeenCalled();
    await pipeline.stop();
  });

  it("exports slot and loop gauges for the pool", async () => {
    const pollNextTask = jest.fn(async () => none);
    const peekNextStartAfter = jest.fn(async () => none);
    const processTask = jest.fn(async () => undefined);
    const pipeline = new TasksPipeline(
      2,
      pollNextTask,
      peekNextStartAfter,
      processTask,
      100,
      undefined,
      "pipeline_gauges",
    );

    await (pipeline as any).loop();
    const metrics = await MetricsService.toJson();

    expect(metrics.gauges["tasks_queue_pool_pipeline_gauges_slots_total"]).toBe(
      2,
    );
    expect(metrics.gauges["tasks_queue_pool_pipeline_gauges_slots_busy"]).toBe(
      0,
    );
    expect(
      metrics.gauges["tasks_queue_pool_pipeline_gauges_loop_running"],
    ).toBe(0);
    expect(
      metrics.gauges[
        "tasks_queue_pool_pipeline_gauges_loop_last_poll_started_at"
      ],
    ).toBe(0);
    expect(
      metrics.gauges[
        "tasks_queue_pool_pipeline_gauges_loop_last_poll_finished_at"
      ],
    ).toBe(0);
    expect(
      metrics.counters[
        "tasks_queue_pool_pipeline_gauges_loop_poll_started_total"
      ],
    ).toBe(1);
    expect(
      metrics.counters[
        "tasks_queue_pool_pipeline_gauges_loop_poll_finished_total"
      ],
    ).toBe(1);
  });

  it("reports a currently stuck polling loop", async () => {
    const deferred = createDeferred<any>();
    const pollNextTask = jest.fn(async () => deferred.promise);
    const peekNextStartAfter = jest.fn(async () => none);
    const processTask = jest.fn(async () => undefined);
    const pipeline = new TasksPipeline(
      1,
      pollNextTask,
      peekNextStartAfter,
      processTask,
      100,
      undefined,
      "pipeline_stuck",
    );

    const loopPromise = (pipeline as any).loop();
    await Promise.resolve();
    jest.setSystemTime(new Date(250));

    const runningMetrics = await MetricsService.toJson();
    expect(
      runningMetrics.gauges["tasks_queue_pool_pipeline_stuck_loop_running"],
    ).toBe(1);
    expect(
      runningMetrics.gauges["tasks_queue_pool_pipeline_stuck_loop_running_ms"],
    ).toBe(250);

    deferred.resolve(none);
    await loopPromise;
  });
});
