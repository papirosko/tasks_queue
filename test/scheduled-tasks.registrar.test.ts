import { describe, expect, it, jest } from "@jest/globals";
import { MetadataScanner } from "@nestjs/core";
import { ScheduledTask } from "../src/scheduled-task.decorator.js";
import { ScheduledTasksRegistrar } from "../src/scheduled-tasks.registrar.js";
import { Worker } from "../src/worker.decorator.js";

class FinanceScheduledTasks {
  @ScheduledTask({
    name: "finance-cron",
    queue: "finance",
    pool: "finance-pool",
    cron: "0 * * * * *",
  })
  async cronTask(): Promise<void> {
    return Promise.resolve();
  }

  @ScheduledTask({
    name: "finance-fixed-rate",
    queue: "finance-fixed-rate",
    fixedRate: 60_000,
    replaceExisting: true,
  })
  async fixedRateTask(): Promise<void> {
    return Promise.resolve();
  }

  @ScheduledTask({
    name: "finance-fixed-delay",
    queue: "finance-fixed-delay",
    fixedDelay: 120_000,
  })
  async fixedDelayTask(): Promise<void> {
    return Promise.resolve();
  }
}

class InvalidScheduledTasks {
  @Worker({ queue: "worker-queue" })
  @ScheduledTask({
    name: "invalid",
    queue: "worker-queue",
    fixedRate: 60_000,
  })
  async brokenTask(): Promise<void> {
    return Promise.resolve();
  }
}

describe("ScheduledTasksRegistrar", () => {
  it("registers decorated methods as workers during module init and provisions schedules on application bootstrap", async () => {
    const tasksPoolsService = {
      registerWorker: jest.fn(),
      scheduleAtCron: jest.fn(async () => undefined),
      scheduleAtFixedRate: jest.fn(async () => undefined),
      scheduleAtFixedDelay: jest.fn(async () => undefined),
    } as any;
    const discoveryService = {
      getProviders: jest.fn(() => [{ instance: new FinanceScheduledTasks() }]),
    } as any;

    const registrar = new ScheduledTasksRegistrar(
      discoveryService,
      new MetadataScanner(),
      tasksPoolsService,
    );

    registrar.onModuleInit();

    expect(tasksPoolsService.registerWorker).toHaveBeenCalledTimes(3);
    expect(tasksPoolsService.registerWorker).toHaveBeenNthCalledWith(
      1,
      "finance",
      expect.anything(),
      "finance-pool",
    );
    expect(tasksPoolsService.registerWorker).toHaveBeenNthCalledWith(
      2,
      "finance-fixed-rate",
      expect.anything(),
      "default",
    );
    expect(tasksPoolsService.registerWorker).toHaveBeenNthCalledWith(
      3,
      "finance-fixed-delay",
      expect.anything(),
      "default",
    );
    expect(tasksPoolsService.scheduleAtCron).not.toHaveBeenCalled();
    expect(tasksPoolsService.scheduleAtFixedRate).not.toHaveBeenCalled();
    expect(tasksPoolsService.scheduleAtFixedDelay).not.toHaveBeenCalled();

    await registrar.onApplicationBootstrap();

    expect(tasksPoolsService.scheduleAtCron).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "finance-cron",
        queue: "finance",
        cronExpression: "0 * * * * *",
      }),
    );
    expect(tasksPoolsService.scheduleAtFixedRate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "finance-fixed-rate",
        queue: "finance-fixed-rate",
        period: 60_000,
        replaceExisting: true,
      }),
    );
    expect(tasksPoolsService.scheduleAtFixedDelay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "finance-fixed-delay",
        queue: "finance-fixed-delay",
        period: 120_000,
      }),
    );
  });

  it("throws when @ScheduledTask is combined with @Worker", () => {
    const tasksPoolsService = {
      registerWorker: jest.fn(),
      scheduleAtCron: jest.fn(async () => undefined),
      scheduleAtFixedRate: jest.fn(async () => undefined),
      scheduleAtFixedDelay: jest.fn(async () => undefined),
    } as any;
    const discoveryService = {
      getProviders: jest.fn(() => [{ instance: new InvalidScheduledTasks() }]),
    } as any;

    const registrar = new ScheduledTasksRegistrar(
      discoveryService,
      new MetadataScanner(),
      tasksPoolsService,
    );

    expect(() => registrar.onModuleInit()).toThrow(
      "cannot be combined with @Worker",
    );
  });

  it("registers worker in default pool when pool is omitted", () => {
    class DefaultPoolScheduledTask {
      @ScheduledTask({
        name: "billing-cron",
        queue: "billing",
        cron: "0 * * * * *",
      })
      async task(): Promise<void> {
        return Promise.resolve();
      }
    }

    const tasksPoolsService = {
      registerWorker: jest.fn(),
      scheduleAtCron: jest.fn(async () => undefined),
      scheduleAtFixedRate: jest.fn(async () => undefined),
      scheduleAtFixedDelay: jest.fn(async () => undefined),
    } as any;
    const discoveryService = {
      getProviders: jest.fn(() => [
        { instance: new DefaultPoolScheduledTask() },
      ]),
    } as any;

    const registrar = new ScheduledTasksRegistrar(
      discoveryService,
      new MetadataScanner(),
      tasksPoolsService,
    );

    registrar.onModuleInit();

    expect(tasksPoolsService.registerWorker).toHaveBeenCalledWith(
      "billing",
      expect.anything(),
      "default",
    );
  });
});
