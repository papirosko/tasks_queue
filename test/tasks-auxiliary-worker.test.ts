import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Collection } from "scats";
import { MetricsService } from "application-metrics";
import { TasksCount } from "../src/manage.model.js";
import { TaskStatus } from "../src/tasks-model.js";
import { TasksAuxiliaryWorker } from "../src/tasks-auxiliary-worker.js";
import { TimeUtils } from "../src/time-utils.js";

jest.mock("application-metrics", () => ({
  MetricsService: {
    gauge: jest.fn(),
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

describe("TasksAuxiliaryWorker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("starts immediate maintenance and metrics passes, then repeats them on schedule until stopped", async () => {
    const dao = {
      failStalled: jest.fn(async () => Collection.from<number>([])),
      resetFailed: jest.fn(async () => undefined),
      clearFinished: jest.fn(async () => undefined),
    };
    const manageService = {
      tasksCount: jest.fn(async () =>
        Collection.of(new TasksCount("preview-jobs", TaskStatus.pending, 2)),
      ),
    };
    const worker = new TasksAuxiliaryWorker(dao as any, manageService as any);

    // Start the auxiliary worker and verify that both one-shot passes run immediately.
    worker.start();
    await Promise.resolve();

    expect(dao.failStalled).toHaveBeenCalledTimes(1);
    expect(dao.resetFailed).toHaveBeenCalledTimes(1);
    expect(dao.clearFinished).toHaveBeenCalledTimes(1);
    expect(manageService.tasksCount).toHaveBeenCalledTimes(1);
    expect(MetricsService.gauge).toHaveBeenCalledWith(
      "tasks_queue_preview_jobs_pending",
      expect.any(Function),
    );

    // Advance by one worker interval and confirm that only maintenance work repeats.
    await jest.advanceTimersByTimeAsync(TimeUtils.second * 30);
    expect(dao.failStalled).toHaveBeenCalledTimes(2);
    expect(dao.resetFailed).toHaveBeenCalledTimes(2);
    expect(dao.clearFinished).toHaveBeenCalledTimes(2);
    expect(manageService.tasksCount).toHaveBeenCalledTimes(1);

    // Advance through the metrics interval and confirm the metrics sync also repeats.
    await jest.advanceTimersByTimeAsync(TimeUtils.second * 90);
    expect(manageService.tasksCount).toHaveBeenCalledTimes(2);

    // Stop the worker and verify that no more timer-driven work runs afterwards.
    const maintenanceCallsBeforeStop = dao.failStalled.mock.calls.length;
    const resetCallsBeforeStop = dao.resetFailed.mock.calls.length;
    const clearFinishedCallsBeforeStop = dao.clearFinished.mock.calls.length;
    const metricsCallsBeforeStop = manageService.tasksCount.mock.calls.length;
    worker.stop();
    await jest.advanceTimersByTimeAsync(TimeUtils.minute * 3);
    expect(dao.failStalled).toHaveBeenCalledTimes(maintenanceCallsBeforeStop);
    expect(dao.resetFailed).toHaveBeenCalledTimes(resetCallsBeforeStop);
    expect(dao.clearFinished).toHaveBeenCalledTimes(clearFinishedCallsBeforeStop);
    expect(manageService.tasksCount).toHaveBeenCalledTimes(metricsCallsBeforeStop);
  });
});
