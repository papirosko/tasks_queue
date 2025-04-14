import { ModuleMetadata, Type } from "@nestjs/common/interfaces";
import pg from "pg";
import { TasksPool } from "./tasks-pool.js";

export interface TasksQueueModuleOptions {
  db: pg.Pool;
  pools: TasksPool[];
}

export const TASKS_QUEUE_OPTIONS = Symbol("TASKS_QUEUE_OPTIONS");

export interface TasksQueueOptionsFactory {
  createTelegrafOptions():
    | Promise<TasksQueueModuleOptions>
    | TasksQueueModuleOptions;
}

export interface TasksQueueAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useExisting?: Type<TasksQueueOptionsFactory>;
  useClass?: Type<TasksQueueOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<TasksQueueModuleOptions> | TasksQueueModuleOptions;
  inject?: any[];
}
