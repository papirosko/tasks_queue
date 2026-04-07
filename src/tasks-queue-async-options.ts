import { ModuleMetadata, Type } from "@nestjs/common/interfaces";
import pg from "pg";
import { TasksPool } from "./tasks-pool.js";

/**
 * Resolved NestJS module options for {@link TasksQueueModule}.
 *
 * This is the final shape produced by {@link TasksQueueAsyncOptions} or
 * {@link TasksQueueOptionsFactory}.
 */
export interface TasksQueueModuleOptions {
  /**
   * PostgreSQL connection pool used by queue services.
   */
  db: pg.Pool;
  /**
   * Worker pools to create inside {@link TasksPoolsService}.
   */
  pools: TasksPool[];
  /**
   * Whether to run the background auxiliary worker.
   *
   * When omitted, the module enables it by default.
   */
  runAuxiliaryWorker?: boolean;
}

/**
 * NestJS injection token that stores resolved
 * {@link TasksQueueModuleOptions}.
 */
export const TASKS_QUEUE_OPTIONS = Symbol("TASKS_QUEUE_OPTIONS");

/**
 * Factory contract for class-based async configuration of
 * {@link TasksQueueModule}.
 */
export interface TasksQueueOptionsFactory {
  /**
   * Produce module options for the queue module.
   *
   * @returns resolved {@link TasksQueueModuleOptions}
   */
  createTelegrafOptions():
    | Promise<TasksQueueModuleOptions>
    | TasksQueueModuleOptions;
}

/**
 * Async NestJS configuration options for {@link TasksQueueModule.forRootAsync}.
 *
 * Supports the standard NestJS patterns: `useFactory`, `useClass`, or
 * `useExisting`.
 */
export interface TasksQueueAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  /**
   * Reuse an existing provider that implements {@link TasksQueueOptionsFactory}.
   */
  useExisting?: Type<TasksQueueOptionsFactory>;
  /**
   * Instantiate a dedicated provider class that implements
   * {@link TasksQueueOptionsFactory}.
   */
  useClass?: Type<TasksQueueOptionsFactory>;
  /**
   * Build options with a plain factory function.
   */
  useFactory?: (
    ...args: any[]
  ) => Promise<TasksQueueModuleOptions> | TasksQueueModuleOptions;
  /**
   * Dependencies injected into {@link useFactory}.
   */
  inject?: any[];
}
