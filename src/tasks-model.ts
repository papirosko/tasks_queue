import type { Option } from "scats";

/**
 * Persistent lifecycle states of a task row.
 *
 * These values are stored in the database and are surfaced by
 * {@link ScheduledTask}, {@link TaskStateSnapshot}, and management APIs such as
 * {@link ManageTasksQueueService.findById}.
 *
 * See also {@link TaskContext.spawnChild} for transitions into `blocked`,
 * and {@link TaskTimedOutError} for timeout-driven transitions.
 */
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

/**
 * Retry backoff formulas supported by the queue.
 *
 * Used by {@link ScheduleTaskDetails.backoffType},
 * {@link UpdatePendingTaskDetails.backoffType}, and timeout / retry handling.
 *
 * See also {@link ScheduleTaskDetails.backoff}.
 */
export enum BackoffType {
  constant = "constant",
  linear = "linear",
  exponential = "exponential",
}

/**
 * Parameters used to schedule a one-time task.
 *
 * This is the base scheduling contract shared by regular tasks and child tasks.
 * Periodic scheduling extends it via {@link SchedulePeriodicTaskDetails} and
 * {@link ScheduleCronTaskDetails}.
 *
 * See also {@link TasksQueueService.schedule} and
 * {@link TasksPoolsService.schedule}.
 */
export interface ScheduleTaskDetails {
  /**
   * Queue name that determines which registered {@link TasksWorker} will process the task.
   *
   * The queue must be registered in a running {@link TasksQueueService} or
   * {@link TasksPoolsService} to be processed immediately.
   */
  queue: string;
  /**
   * Maximum duration in milliseconds for a single processing attempt before it is treated as stalled.
   *
   * The timeout is enforced against the latest persisted liveness point:
   * `started` or `last_heartbeat`.
   *
   * If omitted, the queue uses its default timeout of one hour.
   *
   * See also {@link TaskContext.ping} and {@link TaskTimedOutError}.
   */
  timeout?: number;
  /**
   * Earliest instant when the task becomes eligible for polling.
   *
   * Use this for delayed execution. If omitted or `null` at persistence level,
   * the task may be picked up as soon as a worker is available.
   */
  startAfter?: Date;

  /**
   * Relative priority among eligible pending tasks in the same queue.
   *
   * Higher values are fetched first. If omitted, the default value is `0`.
   */
  priority?: number;
  /**
   * Task input and persisted runtime state passed to {@link TasksWorker.process}.
   *
   * This field is intended for worker input and workflow state, not for the final
   * outcome of execution. Use {@link TaskContext.submitResult} for final output.
   */
  payload?: object;
  /**
   * Maximum number of attempts allowed for the task.
   *
   * The first run counts as attempt `1`. If omitted, the default value is `1`,
   * meaning "do not retry".
   *
   * See also {@link ScheduledTask.currentAttempt}.
   */
  retries?: number;
  /**
   * Base retry delay in milliseconds.
   *
   * This value is combined with {@link backoffType} to calculate `startAfter`
   * when an attempt fails or times out and retries remain.
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
   * Formula used to calculate the next retry delay.
   *
   * - 'constant': always waits the same amount of time (`backoff`) between retries.
   * - 'linear': delay increases linearly with each attempt (`backoff * attempt`).
   * - 'exponential': delay increases exponentially (`backoff * 2^attempt`).
   *
   * If omitted, the default is `linear`.
   */
  backoffType?: BackoffType;
}

/**
 * Periodic scheduling modes supported by the queue.
 *
 * Used by {@link SchedulePeriodicTaskDetails},
 * {@link ScheduleCronTaskDetails}, and management models such as
 * {@link UpdatePendingPeriodicScheduleDetails}.
 */
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

/**
 * Parameters for interval-based periodic tasks.
 *
 * Use with {@link TasksQueueService.scheduleAtFixedRate},
 * {@link TasksQueueService.scheduleAtFixedDelay},
 * {@link TasksPoolsService.scheduleAtFixedRate}, or
 * {@link TasksPoolsService.scheduleAtFixedDelay}.
 */
export interface SchedulePeriodicTaskDetails extends ScheduleTaskDetails {
  /**
   * Unique persistent identifier of the periodic task definition.
   *
   * The queue uses this name for deduplication, so only one periodic task with
   * the same name may exist.
   */
  name: string;

  /**
   * Interval in milliseconds used by `fixed_rate` or `fixed_delay` scheduling.
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

/**
 * Parameters for cron-based periodic tasks.
 *
 * Use with {@link TasksQueueService.scheduleAtCron} or
 * {@link TasksPoolsService.scheduleAtCron}.
 */
export interface ScheduleCronTaskDetails extends ScheduleTaskDetails {
  /**
   * Unique persistent identifier of the periodic task definition.
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
 * Runtime snapshot of a task fetched for processing.
 *
 * The queue passes this shape internally into the worker pipeline. Its fields
 * describe the currently owned attempt and are used to enforce ownership checks
 * for finish, fail, heartbeat, child blocking, and periodic rescheduling.
 *
 * See also {@link TaskContext} and {@link TaskStateSnapshot}.
 */
export interface ScheduledTask {
  /**
   * Persistent task id in the database.
   */
  id: number;
  /**
   * The exact `started` timestamp of the currently owned processing attempt.
   *
   * Runtime transitions must use this value to ensure that only the worker
   * which fetched the current attempt may heartbeat or resolve it.
   */
  started: Date;
  /**
   * Parent task id if this task was spawned by {@link TaskContext.spawnChild}.
   */
  parentId?: number;
  /**
   * Task input and persisted runtime state for the current execution.
   * */
  payload?: object;
  /**
   * Queue name this task belongs to.
   */
  queue: string;
  /**
   * Periodic scheduling mode for periodic tasks, or `undefined` for one-time tasks.
   */
  repeatType?: TaskPeriodType;
  /**
   * Timeout in milliseconds for the currently owned attempt.
   *
   * See also {@link ScheduleTaskDetails.timeout}.
   */
  timeout: number;

  /**
   * Current attempt number starting from `1`.
   */
  currentAttempt: number;
  /**
   * Maximum number of attempts allowed for this task.
   */
  maxAttempts: number;
}

/**
 * Parameters for a child task requested from inside a parent workflow.
 *
 * This extends the base one-time scheduling contract with parent-side
 * orchestration metadata.
 *
 * See also {@link TaskContext.spawnChild}, {@link MultiStepTask}, and
 * {@link SequentialTask}.
 */
export interface SpawnChildTaskDetails extends ScheduleTaskDetails {
  /**
   * If true, parent workflow may decide to continue when this child ends in terminal `error`.
   *
   * The child task itself still keeps `status='error'`. This flag affects only parent-side
   * orchestration metadata persisted in `MultiStepPayload.activeChild`.
   */
  allowFailure?: boolean;
}

/**
 * Persistent read-only snapshot of a task state used by orchestration code.
 *
 * Returned by {@link TaskContext.findTask} and exposed through
 * {@link TaskContext.resolvedChildTask} when a blocked parent resumes after a
 * child reaches a terminal state.
 *
 * See also {@link ManageTasksQueueService.findById} for the management view.
 */
export interface TaskStateSnapshot {
  /**
   * Persistent task id.
   */
  id: number;
  /**
   * Parent task id if this is a child task.
   */
  parentId: number | undefined;
  /**
   * Current persistent task status.
   */
  status: TaskStatus;
  /**
   * Persisted task input and runtime state.
   */
  payload: object | undefined;
  /**
   * Persisted final result submitted by the worker, if any.
   *
   * Parent workflows should read child output from this field rather than from
   * {@link payload}.
   */
  result: Option<object>;
  /**
   * Last persisted terminal or retry-triggering error message, if any.
   */
  error: string | undefined;
}

/**
 * Minimum interval between persisted heartbeat writes for the same attempt.
 *
 * Runtime code may call {@link TaskContext.ping} more often, but the queue
 * throttles persistence to protect the database.
 */
export const TASK_HEARTBEAT_THROTTLE_MS = 60_000;

/**
 * Signals a retryable task failure with payload replacement.
 *
 * When thrown from {@link TasksWorker.process}, the queue treats the attempt as
 * failed but, if retries remain, persists {@link payload} as the next retry
 * payload instead of keeping the previous payload unchanged.
 *
 * This is especially useful for stateful retry flows that need to record
 * derived retry metadata between attempts.
 *
 * See also {@link TaskContext.setPayload} and {@link TaskContext.submitResult}.
 */
export class TaskFailed extends Error {
  constructor(
    message: string,
    /**
     * Replacement payload to persist for the next retry attempt.
     */
    readonly payload: object,
  ) {
    super(message);
  }
}

/**
 * Raised when the current processing attempt is already considered stalled by the queue timeout contract.
 *
 * This means the worker either reported heartbeat too late or returned from `process(...)`
 * after the timeout window had already elapsed for the current persisted heartbeat/start time.
 */
export class TaskTimedOutError extends Error {
  constructor(
    /**
     * Task id whose currently owned attempt timed out.
     */
    readonly taskId: number,
    /**
     * Final status produced by timeout handling for this attempt.
     *
     * This is typically `pending` when retries remain or `error` when retries
     * are exhausted.
     */
    readonly finalStatus: TaskStatus,
  ) {
    super(`Task ${taskId} timed out before liveness was refreshed`);
  }
}

/**
 * Runtime API exposed to {@link TasksWorker.process}.
 *
 * It provides liveness control, payload/result persistence, child orchestration,
 * and child-state inspection for the currently owned attempt only.
 *
 * All mutating methods are ownership-aware: stale attempts may complete in
 * memory, but they cannot mutate queue state once ownership has moved to a new
 * attempt.
 *
 * See also {@link TasksWorker}, {@link MultiStepTask}, and
 * {@link SequentialTask}.
 */
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
   *
   * Returns a resolved promise when the task is still healthy. Throws
   * {@link TaskTimedOutError} if the current attempt has already exceeded the
   * timeout window since the last persisted liveness point.
   */
  ping(): Promise<void>;
  /**
   * Replace the payload that will be persisted when the current task leaves `in_progress`.
   *
   * This is primarily useful for stateful orchestration tasks that need to checkpoint
   * workflow state before blocking, finishing, or being rescheduled.
   *
   * @param payload next payload to persist
   * @returns nothing; the payload is applied when the attempt resolves
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
   * @returns nothing; the result is persisted when the attempt resolves
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
   * @returns snapshot of the task if found, otherwise `none`
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
   * @returns nothing; the child is created only after successful parent return
   */
  spawnChild(task: SpawnChildTaskDetails): void;
}
