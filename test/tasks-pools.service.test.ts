import { afterEach, beforeEach, jest } from "@jest/globals";
import { TasksPoolsService, DEFAULT_POOL } from "../src/tasks-pools.service.js";
import { TasksRuntimeStateService } from "../src/tasks-runtime-state.service.js";
import { TasksWorker } from "../src/tasks-worker.js";
import { none, some } from "scats";
import { TaskPeriodType } from "../src/tasks-model.js";

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
}

describe("TasksPoolsService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // Expect duplicate pool names to fail fast with a clear error.
  it("throws when pool names are duplicated", () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;

    expect(
      () =>
        new TasksPoolsService(dao as any, manageService, false, [
          { name: "p1", concurrency: 1, loopInterval: 10 },
          { name: "p1", concurrency: 2, loopInterval: 20 },
        ]),
    ).toThrow("Duplicate pool names detected");
  });

  // Expect registration in an unknown pool to throw.
  it("throws when registering a worker in an unknown pool", () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;
    const service = new TasksPoolsService(dao as any, manageService, false);

    expect(() =>
      service.registerWorker("q", new TestWorker(), "missing"),
    ).toThrow("Pool 'missing' not registered");
  });

  // Expect duplicate queue registration to be rejected.
  it("throws when registering the same queue twice", () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;
    const service = new TasksPoolsService(dao as any, manageService, false);

    service.registerWorker("q", new TestWorker(), DEFAULT_POOL);

    expect(() =>
      service.registerWorker("q", new TestWorker(), DEFAULT_POOL),
    ).toThrow("Queue 'q' is already registered");
  });

  // Expect taskScheduled to be routed to the correct pool service.
  it("routes taskScheduled to the correct pool", async () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;
    const service = new TasksPoolsService(dao as any, manageService, false, [
      { name: DEFAULT_POOL, concurrency: 1, loopInterval: 10 },
      { name: "preview", concurrency: 1, loopInterval: 10 },
    ]);

    service.registerWorker("preview-queue", new TestWorker(), "preview");

    const pools = (service as any).pools;
    const previewPool = pools.get("preview").getOrElseValue(null);
    const taskScheduledSpy = jest.spyOn(previewPool, "taskScheduled");
    taskScheduledSpy.mockImplementation(() => undefined);

    await service.schedule({ queue: "preview-queue" } as any);

    expect(taskScheduledSpy).toHaveBeenCalledWith("preview-queue");
  });

  // Expect scheduleAtCron to store a periodic task with cron repeat type.
  it("schedules cron tasks with cron repeat type", async () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;
    const service = new TasksPoolsService(dao as any, manageService, false);

    await service.scheduleAtCron({
      queue: "q",
      name: "cron-task",
      cronExpression: "*/10 * * * * *",
    });

    expect(dao.schedulePeriodic).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cron-task" }),
      TaskPeriodType.cron,
      expect.any(Date),
    );
  });

  it("clears stop timeout timer after successful shutdown", async () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;
    const service = new TasksPoolsService(dao as any, manageService, false, [
      { name: DEFAULT_POOL, concurrency: 1, loopInterval: 10 },
    ]);

    const pools = (service as any).pools;
    const defaultPool = pools.get(DEFAULT_POOL).getOrElseValue(null);
    jest.spyOn(defaultPool, "stop").mockImplementation(async () => undefined);

    await service.stop(30000);

    expect(jest.getTimerCount()).toBe(0);
  });

  it("returns runtime snapshot with pools and registered workers", () => {
    const dao = {
      schedule: jest.fn(async () => some(1)),
      schedulePeriodic: jest.fn(async () => some(2)),
      nextPending: jest.fn(async () => none),
      peekNextStartAfter: jest.fn(async () => none),
    };
    const manageService = {} as any;
    const runtimeStateService = new TasksRuntimeStateService();
    const service = new TasksPoolsService(
      dao as any,
      manageService,
      false,
      [
        { name: DEFAULT_POOL, concurrency: 2, loopInterval: 10 },
        { name: "preview", concurrency: 1, loopInterval: 20 },
      ],
      undefined,
      runtimeStateService,
    );

    service.registerWorker("email", new TestWorker(), DEFAULT_POOL);
    service.registerWorker("generate-preview", new TestWorker(), "preview");
    service.start();

    const snapshot = runtimeStateService.getSnapshot();

    expect(snapshot.queueToPool).toEqual({
      email: DEFAULT_POOL,
      "generate-preview": "preview",
    });
    expect(snapshot.pools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: DEFAULT_POOL,
          started: true,
          registeredQueues: ["email"],
          slots: expect.objectContaining({ total: 2, busy: 0, idle: 2 }),
          workers: [
            expect.objectContaining({
              queueName: "email",
              workerClass: "TestWorker",
            }),
          ],
        }),
        expect.objectContaining({
          name: "preview",
          started: true,
          registeredQueues: ["generate-preview"],
          slots: expect.objectContaining({ total: 1, busy: 0, idle: 1 }),
          workers: [
            expect.objectContaining({
              queueName: "generate-preview",
              workerClass: "TestWorker",
            }),
          ],
        }),
      ]),
    );
  });
});
