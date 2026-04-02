import type { Option } from "scats";

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
   * Task is waiting for its child task to reach a terminal state.
   */
  blocked = "blocked",
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
   * If not set, the default value 1 hour will be used.
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
   * Task input and persisted runtime state that will be passed to a queue worker on start.
   *
   * This field is not intended to represent the final outcome of task execution.
   */
  payload?: object;
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
   * If not set, defaults to 'linear'.
   */
  backoffType?: BackoffType;
}

export enum TaskPeriodType {
  fixed_rate = "fixed_rate",
  fixed_delay = "fixed_delay",
  cron = "cron",
}

/**
 * Defines the strategy for handling missed periodic task executions
 * (e.g., when the server is down or the task couldn't run on time).
 */
export enum MissedRunStrategy {
  /**
   * Execute the task once for every missed interval since the original schedule.
   * Useful when every run is important (e.g., collecting metrics).
   */
  catch_up = "catch_up",

  /**
   * Execute the task once immediately and schedule the task for the next appropriate time
   * based on the original interval (e.g., every hour at 15:00, 16:00, etc.).
   */
  skip_missed = "skip_missed",
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

  /**
   * Strategy that defines how to handle missed executions for a periodic task
   * when the server is down or delayed. Default value: 'skip_missed'
   *
   * - 'catch_up' — execute the task once for each missed interval since its creation time.
   * - 'skip_missed' — run once immediately and schedule the next one based on the original schedule.
   */
  missedRunStrategy?: MissedRunStrategy;
}

export interface ScheduleCronTaskDetails extends ScheduleTaskDetails {
  /**
   * The unique name for the periodic task for the deduplication.
   */
  name: string;

  /**
   * Cron expression that defines the periodic execution schedule.
   *
   * Supported formats:
   * - 5 fields: minute, hour, day of month, month, day of week
   * - 6 fields: second, minute, hour, day of month, month, day of week
   *
   * In the current implementation, cron schedules are evaluated in UTC.
   */
  cronExpression: string;

  /**
   * Strategy that defines how to handle missed executions for a periodic task
   * when the server is down or delayed. Default value: 'skip_missed'
   *
   * - 'catch_up' — execute the task once for each missed schedule tick.
   * - 'skip_missed' — run once and schedule the next future tick.
   */
  missedRunStrategy?: MissedRunStrategy;
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
   * Parent task id if this task was spawned by another task.
   */
  parentId?: number;
  /**
   * Task input and persisted runtime state for the current execution.
   * */
  payload?: object;
  /**
   * The name of the queue tasks belongs to.
   */
  queue: string;
  /**
   * The period type for the periodic tasks. Not set for regular task.
   */
  repeatType?: TaskPeriodType;

  currentAttempt: number;
  maxAttempts: number;
}

export interface SpawnChildTaskDetails extends ScheduleTaskDetails {
  /**
   * If true, parent workflow may decide to continue when this child ends in terminal `error`.
   *
   * The child task itself still keeps `status='error'`. This flag affects only parent-side
   * orchestration metadata persisted in `MultiStepPayload.activeChild`.
   */
  allowFailure?: boolean;
}

export interface TaskStateSnapshot {
  id: number;
  parentId: number | undefined;
  status: TaskStatus;
  /**
   * Persisted task input and runtime state.
   */
  payload: object | undefined;
  /**
   * Persisted final task result produced by the worker, if any.
   */
  result: Option<object>;
  error: string | undefined;
}

export const TASK_HEARTBEAT_THROTTLE_MS = 60_000;

/**
 * If this error is thrown from the process method of the task, then returned payload
 * will be stored as a new task payload, replacing the previous one.
 *
 * This can be used to store additional task metadata for the special tasks, which
 * provide their own task flow.
 */
export class TaskFailed extends Error {
  constructor(
    message: string,
    readonly payload: object,
  ) {
    super(message);
  }
}

export interface TaskContext {
  /**
   * Current task id in persistent storage.
   */
  taskId: number;
  /**
   * Current processing attempt number starting from 1.
   */
  currentAttempt: number;
  /**
   * Maximum number of attempts allowed for this task.
   */
  maxAttempts: number;
  /**
   * Snapshot of the child task that has just been resolved for the current parent wake-up pass.
   *
   * This field is populated only for multi-step parent workflows after a previously blocked
   * child has reached terminal `finished` or terminal `error` and the parent is executing the
   * continuation path in the same runtime context.
   */
  resolvedChildTask: Option<TaskStateSnapshot>;
  /**
   * Persist a heartbeat for the current task to prevent false stalled detection
   * during long-running processing.
   *
   * Frequent repeated calls are throttled by the runtime and persistence layer.
   */
  ping(): Promise<void>;
  /**
   * Replace the payload that will be persisted when the current task leaves `in_progress`.
   *
   * This is primarily useful for stateful orchestration tasks that need to checkpoint
   * workflow state before blocking, finishing, or being rescheduled.
   *
   * @param payload next payload to persist
   */
  setPayload(payload: object): void;
  /**
   * Submit the final result to persist after the current `process()` call completes.
   *
   * This request is stored only in memory during the current runtime pass. The queue core
   * persists it after successful completion or terminal failure of the task.
   *
   * Unlike {@link setPayload}, this method is intended for task output, not workflow state.
   *
   * @param result final task result to persist
   */
  submitResult(result: object): void;
  /**
   * Load a task snapshot by id from persistent storage.
   *
   * This is intended for orchestration helpers that need to inspect child task state,
   * including its final result,
   * while remaining independent from management services.
   *
   * @param taskId task id to load
   */
  findTask(taskId: number): Promise<Option<TaskStateSnapshot>>;
  /**
   * Request spawning a single child task after the current `process()` call completes successfully.
   *
   * The child is not created immediately. The runtime stores the request in memory and
   * the queue core creates the child task only after `process()` returns without throwing.
   *
   * Only one child task can be requested during a single `process()` execution.
   * If `task.allowFailure` is set, the runtime persists that policy into
   * `MultiStepPayload.activeChild`, so parent workflow may inspect it later in
   * `childFailed(...)`.
   *
   * @param task one-time child task details
   */
  spawnChild(task: SpawnChildTaskDetails): void;
}
