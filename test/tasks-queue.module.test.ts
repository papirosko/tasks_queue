import { describe, expect, it } from "@jest/globals";
import { Collection, Nil, option } from "scats";
import { TasksQueueModule } from "../src/tasks-queue.module.js";
import { ScheduledTasksRegistrar } from "../src/scheduled-tasks.registrar.js";
import { TasksRuntimeStateService } from "../src/tasks-runtime-state.service.js";

describe("TasksQueueModule", () => {
  it("includes ScheduledTasksRegistrar by default", () => {
    const moduleDefinition = TasksQueueModule.forRootAsync({
      useFactory: () => ({
        db: {} as any,
        pools: [],
      }),
    });

    const providers = option(moduleDefinition.providers)
      .map((items) => Collection.from(items))
      .getOrElseValue(Nil);

    expect(providers.toArray).toContain(ScheduledTasksRegistrar);
  });

  it("omits ScheduledTasksRegistrar when disabled", () => {
    const moduleDefinition = TasksQueueModule.forRootAsync({
      runScheduledTasksRegistrar: false,
      useFactory: () => ({
        db: {} as any,
        pools: [],
      }),
    });

    const providers = option(moduleDefinition.providers)
      .map((items) => Collection.from(items))
      .getOrElseValue(Nil);

    expect(providers.toArray).not.toContain(ScheduledTasksRegistrar);
  });

  it("exports TasksRuntimeStateService", () => {
    const moduleDefinition = TasksQueueModule.forRootAsync({
      useFactory: () => ({
        db: {} as any,
        pools: [],
      }),
    });

    const exports = option(moduleDefinition.exports)
      .map((items) => Collection.from(items))
      .getOrElseValue(Nil);

    expect(exports.toArray).toContain(TasksRuntimeStateService);
  });
});
