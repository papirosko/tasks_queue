import { afterEach, beforeEach, jest } from "@jest/globals";
import { none, some } from "scats";
import { TasksPipeline } from "../src/tasks-pipeline.js";
import type { ScheduledTask } from "../src/tasks-model.js";

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
    );

    pipeline.triggerLoop();
    await jest.advanceTimersByTimeAsync(1);
    await jest.runOnlyPendingTimersAsync();

    expect(pollNextTask).toHaveBeenCalled();
    await pipeline.stop();
  });
});
