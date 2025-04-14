export enum TaskStatus {
  /**
   * Task is waiting for a worker to fetch it and to start processing.
   * Once the worker will fetch the task, its status will be changed to 'in_progress'.
   */
  pending = "pending",
  /**
   * Task was fetched by worker and is being processed. If the task will be successfully processed,
   * its status will be changed to 'finished.
   * If the task will fail, its status will be changed to 'error'.
   * If the task will be detected as stalled, its status will be changed to 'error'.
   */
  in_progress = "in_progress",
  /**
   * Task was successfully finished.
   */
  finished = "finished",
  /**
   * Task failed to finish. If the number of attempts is less than maximum allowed
   * attempts, the task will be requeued by changing its status to 'pending'.
   */
  error = "error",
}

export enum BackoffType {
  constant = "constant",
  linear = "linear",
  exponential = "exponential",
}

/**
 * The parameters of the new task to be added to a quueue.
 */
export interface ScheduleTaskDetails {
  /**
   * The name of the queue, where the task should be placed.
   */
  queue: string;
  /**
   * Maximum amount of the time in milliseconds, after which the task will be considered as 'stalled'.
   * If not set, task will never be marked as 'stalled' and will never be requeued.
   */
  timeout?: number;
  /**
   * The date after that the task should be picked up by a worker.
   */
  startAfter?: Date;

  /**
   * Task priority defines the order in which tasks are fetched from db. The highest values comes first.
   * Default value is 0.
   */
  priority?: number;
  /**
   * Task details, that will be passed to a queue worker upon starting working on this task.
   */
  payload: object;
  /**
   * Maximum number of attempts for the task to be executed in case the task was failed or stalled.
   * If not set, will use default value 1.
   */
  retries?: number;
  /**
   * The delay before retrying a failed task, in milliseconds.
   * Used as a base value when calculating the retry delay.
   *
   * Actual delay depends on `backoffType`:
   * - 'constant': delay = backoff
   * - 'linear': delay = backoff * attempt
   * - 'exponential': delay = backoff * (2 ^ attempt)
   *
   * If not set, defaults to 60000 (1 minute).
   */
  backoff?: number;

  /**
   * Strategy used to calculate the delay before retrying a failed task.
   *
   * - 'constant': always waits the same amount of time (`backoff`) between retries.
   * - 'linear': delay increases linearly with each attempt (`backoff * attempt`).
   * - 'exponential': delay increases exponentially (`backoff * 2^attempt`).
   *
   * If not set, defaults to 'exponential'.
   */
  backoffType?: BackoffType;
}

export enum TaskPeriodType {
  fixed_rate = "fixed_rate",
  fixed_delay = "fixed_delay",
}

export interface SchedulePeriodicTaskDetails extends ScheduleTaskDetails {
  /**
   * The unique name for the periodic task for the deduplication.
   */
  name: string;

  /**
   * The interval, after which the task should be processed again.
   */
  period: number;
}

/**
 * The details of the fetched task.
 */
export interface ScheduledTask {
  /**
   * Task id in the DB.
   */
  id: number;
  /**
   * Task details, that were specified during task creation..
   * */
  payload: object;
  /**
   * The name of the queue tasks belongs to.
   */
  queue: string;
  /**
   * The period type for the periodic tasks. Not set for regular task.
   */
  repeatType?: TaskPeriodType;
}
