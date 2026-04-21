import { describe, expect, it, jest } from "@jest/globals";
import { MetadataScanner } from "@nestjs/core";
import { ScheduledTask } from "../src/scheduled-task.decorator.js";
import { ScheduledTasksRegistrar } from "../src/scheduled-tasks.registrar.js";
import { Worker } from "../src/worker.decorator.js";

class FinanceScheduledTasks {
  @ScheduledTask({
    name: "finance-cron",
    queue: "finance",
    cron: "0 * * * * *",
  })
  async cronTask(): Promise<void> {
    return Promise.resolve();
  }

  @ScheduledTask({
    name: "finance-fixed-rate",
    queue: "finance",
    fixedRate: 60_000,
    replaceExisting: true,
  })
  async fixedRateTask(): Promise<void> {
    return Promise.resolve();
  }

  @ScheduledTask({
    name: "finance-fixed-delay",
    queue: "finance",
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
    queue: "schedule-queue",
    fixedRate: 60_000,
  })
  async brokenTask(): Promise<void> {
    return Promise.resolve();
  }
}

describe("ScheduledTasksRegistrar", () => {
  it("discovers scheduled decorators and provisions periodic tasks", async () => {
    const tasksPoolsService = {
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

    await registrar.onModuleInit();

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
        queue: "finance",
        period: 60_000,
        replaceExisting: true,
      }),
    );
    expect(tasksPoolsService.scheduleAtFixedDelay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "finance-fixed-delay",
        queue: "finance",
        period: 120_000,
      }),
    );
  });

  it("throws when @ScheduledTask queue does not match @Worker queue", async () => {
    const tasksPoolsService = {
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

    await expect(registrar.onModuleInit()).rejects.toThrow(
      "does not match @Worker queue",
    );
  });
});
