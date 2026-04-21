import "reflect-metadata";
import { BackoffType, MissedRunStrategy } from "./tasks-model.js";

/**
 * Metadata key that marks methods with periodic task schedule definition.
 */
export const TASKS_QUEUE_SCHEDULED_TASK_METADATA = Symbol(
  "tasks-queue-scheduled-task-metadata",
);

interface ScheduledTaskBaseOptions {
  /**
   * Unique periodic task name used for deduplication.
   */
  name: string;
  /**
   * Queue that should receive periodic task runs.
   */
  queue: string;
  /**
   * Optional initial start time.
   */
  startAfter?: Date;
  /**
   * Optional task priority.
   */
  priority?: number;
  /**
   * Optional payload passed to the worker.
   */
  payload?: object;
  /**
   * Optional per-attempt timeout in milliseconds.
   */
  timeout?: number;
  /**
   * Optional maximum attempts.
   */
  retries?: number;
  /**
   * Optional retry backoff in milliseconds.
   */
  backoff?: number;
  /**
   * Optional retry backoff type.
   */
  backoffType?: BackoffType;
  /**
   * Optional periodic missed-run strategy.
   */
  missedRunStrategy?: MissedRunStrategy;
  /**
   * If true, replaces an existing periodic task with the same name.
   */
  replaceExisting?: boolean;
}

export interface ScheduledCronTaskOptions extends ScheduledTaskBaseOptions {
  /**
   * Cron expression for periodic scheduling.
   */
  cron: string;
  fixedRate?: never;
  fixedDelay?: never;
}

export interface ScheduledFixedRateTaskOptions
  extends ScheduledTaskBaseOptions {
  /**
   * Fixed-rate interval in milliseconds.
   */
  fixedRate: number;
  cron?: never;
  fixedDelay?: never;
}

export interface ScheduledFixedDelayTaskOptions
  extends ScheduledTaskBaseOptions {
  /**
   * Fixed-delay interval in milliseconds.
   */
  fixedDelay: number;
  cron?: never;
  fixedRate?: never;
}

/**
 * Method-level schedule definition discovered via NestJS providers.
 */
export type ScheduledTaskOptions =
  | ScheduledCronTaskOptions
  | ScheduledFixedRateTaskOptions
  | ScheduledFixedDelayTaskOptions;

/**
 * Mark a provider method with a periodic schedule declaration.
 *
 * The decorator only declares schedule metadata. It does not register a queue worker.
 */
export const ScheduledTask =
  (options: ScheduledTaskOptions): MethodDecorator =>
  (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    if (typeof descriptor.value !== "function") {
      throw new Error(
        "@ScheduledTask decorator can only be applied to methods",
      );
    }

    const scheduleVariants = [
      options.cron !== undefined,
      options.fixedRate !== undefined,
      options.fixedDelay !== undefined,
    ].filter((v) => v).length;
    if (scheduleVariants !== 1) {
      throw new Error(
        "@ScheduledTask requires exactly one schedule field: 'cron', 'fixedRate', or 'fixedDelay'",
      );
    }

    Reflect.defineMetadata(
      TASKS_QUEUE_SCHEDULED_TASK_METADATA,
      { ...options },
      descriptor.value,
    );
  };
