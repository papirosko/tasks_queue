import { Collection, Option } from "scats";
import { ApiProperty } from "@nestjs/swagger";
import {
  BackoffType,
  MissedRunStrategy,
  TaskPeriodType,
  TaskStatus,
} from "./tasks-model.js";

/**
 * Rich management DTO representing a single task row.
 *
 * This shape is used by {@link ManageTasksQueueService} and preserves optional
 * database fields as `Option` values for server-side consumers.
 *
 * See also {@link TaskView} for a plain JSON / Swagger-friendly representation.
 */
export class TaskDto {
  constructor(
    /**
     * Persistent task id.
     */
    readonly id: number,
    /**
     * Parent task id for child tasks, otherwise `none`.
     */
    readonly parentId: Option<number>,
    /**
     * Queue name the task belongs to.
     */
    readonly queue: string,
    /**
     * Row creation time.
     */
    readonly created: Date,
    /**
     * Original schedule anchor used for periodic tasks and wait-time metrics.
     */
    readonly initialStart: Date,
    /**
     * Start time of the currently persisted attempt, if any.
     */
    readonly started: Option<Date>,
    /**
     * Terminal or retry-transition finish time, if the task is not currently active.
     */
    readonly finished: Option<Date>,
    /**
     * Current persistent task status.
     */
    readonly status: TaskStatus,
    /**
     * Periodic missed-run strategy in effect for this task.
     */
    readonly missedRunStrategy: MissedRunStrategy,
    /**
     * Queue priority used among eligible pending tasks.
     */
    readonly priority: number,
    /**
     * Last persisted error message, if any.
     */
    readonly error: Option<string>,
    /**
     * Base retry backoff in milliseconds.
     */
    readonly backoff: number,
    /**
     * Retry backoff formula.
     */
    readonly backoffType: BackoffType,
    /**
     * Attempt timeout in milliseconds.
     */
    readonly timeout: number,
    /**
     * Unique periodic task name, if this task is periodic.
     */
    readonly name: Option<string>,
    /**
     * Earliest time when the task may start again.
     */
    readonly startAfter: Option<Date>,
    /**
     * Repeat interval in milliseconds for interval-based periodic tasks.
     */
    readonly repeatInterval: Option<number>,
    /**
     * Cron expression for cron-based periodic tasks.
     */
    readonly cronExpression: Option<string>,
    /**
     * Periodic scheduling mode, if any.
     */
    readonly repeatType: Option<TaskPeriodType>,
    /**
     * Maximum attempts allowed for this task.
     */
    readonly maxAttempts: number,
    /**
     * Persisted attempt counter.
     */
    readonly attempt: number,
    /**
     * Persisted worker input and runtime state.
     */
    readonly payload: any,
    /**
     * Persisted final result, if any.
     */
    readonly result: any,
  ) {}
}

/**
 * Paginated collection returned by {@link ManageTasksQueueService.findByParameters}.
 */
export class TasksResult {
  constructor(
    /**
     * Page items in the requested order.
     */
    readonly items: Collection<TaskDto>,
    /**
     * Total number of matching rows before pagination.
     */
    readonly total: number,
  ) {}
}

/**
 * Search parameters for listing tasks from the management API.
 */
export interface FindTasksParameters {
  /**
   * Optional task status filter.
   */
  status?: TaskStatus;

  /**
   * Optional queue name filter.
   */
  queue?: string;

  /**
   * Pagination offset.
   */
  offset: number;

  /**
   * Pagination limit.
   */
  limit: number;
}

/**
 * Full editable configuration for a pending task.
 *
 * This model is intended for "read task -> modify fields -> submit updated state"
 * workflows, so all values are required explicitly instead of being patch-style optional.
 */
export interface UpdatePendingTaskDetails {
  /**
   * Earliest time when the task may be picked up by a worker.
   * Set to null to make the task eligible immediately.
   */
  startAfter: Date | null;

  /**
   * Higher values are fetched first among pending tasks.
   */
  priority: number;

  /**
   * Maximum execution time in milliseconds before the task is considered stalled.
   */
  timeout: number;

  /**
   * Payload to pass to the worker. Can be null to clear the payload.
   */
  payload: any;

  /**
   * Maximum number of processing attempts for the task.
   */
  retries: number;

  /**
   * Base delay in milliseconds before retrying a failed task.
   */
  backoff: number;

  /**
   * Strategy used to calculate retry delay.
   */
  backoffType: BackoffType;
}

/**
 * Full editable periodic schedule for a pending periodic task.
 *
 * The shape is discriminated by repeat type so interval-based and cron-based
 * schedules remain mutually exclusive.
 */
export type UpdatePendingPeriodicScheduleDetails =
  | {
      /**
       * Earliest time for the next execution according to the edited schedule.
       */
      startAfter: Date;

      /**
       * Fixed schedule anchor used by periodic scheduling logic.
       */
      initialStart: Date;

      /**
       * Periodic mode that uses a repeat interval in milliseconds.
       */
      repeatType: TaskPeriodType.fixed_rate | TaskPeriodType.fixed_delay;

      /**
       * Interval in milliseconds between task executions.
       */
      period: number;

      /**
       * Strategy for handling runs missed while the task could not execute.
       */
      missedRunStrategy: MissedRunStrategy;
    }
  | {
      /**
       * Earliest time for the next execution according to the edited schedule.
       */
      startAfter: Date;

      /**
       * Fixed schedule anchor used by periodic scheduling logic.
       */
      initialStart: Date;

      /**
       * Periodic mode that uses a cron expression.
       */
      repeatType: TaskPeriodType.cron;

      /**
       * Cron expression in 5-field or 6-field format.
       */
      cronExpression: string;

      /**
       * Strategy for handling runs missed while the task could not execute.
       */
      missedRunStrategy: MissedRunStrategy;
    };

/**
 * Plain JSON representation of {@link TaskDto} intended for HTTP APIs and Swagger schemas.
 */
export class TaskView {
  /**
   * Persistent task id.
   */
  @ApiProperty()
  id!: number;

  /**
   * Parent task id for child tasks, if any.
   */
  @ApiProperty({ required: false })
  parentId?: number;

  /**
   * Queue name.
   */
  @ApiProperty()
  queue!: string;

  /**
   * Task creation time as Unix milliseconds.
   */
  @ApiProperty()
  created!: number;

  /**
   * Original schedule anchor as Unix milliseconds.
   */
  @ApiProperty()
  initialStart!: number;

  /**
   * Current attempt start time as Unix milliseconds, if the task is active.
   */
  @ApiProperty({ required: false })
  started?: number;

  /**
   * Finish or retry-transition time as Unix milliseconds, if present.
   */
  @ApiProperty({ required: false })
  finished?: number;

  /**
   * Current task status.
   */
  @ApiProperty()
  status!: TaskStatus;

  /**
   * Periodic missed-run strategy.
   */
  @ApiProperty()
  missedRunStrategy!: MissedRunStrategy;

  /**
   * Queue priority.
   */
  @ApiProperty()
  priority!: number;

  /**
   * Last persisted error message, if any.
   */
  @ApiProperty({ required: false })
  error?: string;

  /**
   * Base retry backoff in milliseconds.
   */
  @ApiProperty()
  backoff!: number;

  /**
   * Retry backoff formula.
   */
  @ApiProperty()
  backoffType!: BackoffType;

  /**
   * Attempt timeout in milliseconds.
   */
  @ApiProperty()
  timeout!: number;

  /**
   * Unique periodic task name, if periodic.
   */
  @ApiProperty({ required: false })
  name?: string;

  /**
   * Next eligible start time as Unix milliseconds, if any.
   */
  @ApiProperty()
  startAfter?: number;

  /**
   * Repeat interval in milliseconds for interval-based periodic tasks.
   */
  @ApiProperty()
  repeatInterval?: number;

  /**
   * Cron expression for cron-based periodic tasks.
   */
  @ApiProperty()
  cronExpression?: string;

  /**
   * Periodic scheduling mode, if any.
   */
  @ApiProperty()
  repeatType?: TaskPeriodType;

  /**
   * Maximum attempts allowed.
   */
  @ApiProperty()
  maxAttempts!: number;

  /**
   * Persisted attempt counter.
   */
  @ApiProperty()
  attempt!: number;

  /**
   * Persisted worker input and runtime state.
   */
  @ApiProperty()
  payload: any;

  /**
   * Persisted final result, if any.
   */
  @ApiProperty({ required: false })
  result?: any;

  /**
   * Convert a rich DTO into a plain JSON-friendly view.
   *
   * @param dto management DTO
   * @returns converted API view
   */
  static fromDto(dto: TaskDto) {
    const res = new TaskView();
    res.id = dto.id;
    res.parentId = dto.parentId.orUndefined;
    res.queue = dto.queue;
    res.created = dto.created.getTime();
    res.initialStart = dto.initialStart.getTime();
    res.started = dto.started.map((d) => d.getTime()).orUndefined;
    res.finished = dto.finished.map((d) => d.getTime()).orUndefined;
    res.status = dto.status;
    res.missedRunStrategy = dto.missedRunStrategy;
    res.priority = dto.priority;
    res.error = dto.error.orUndefined;
    res.backoff = dto.backoff;
    res.backoffType = dto.backoffType;
    res.timeout = dto.timeout;
    res.name = dto.name.orUndefined;
    res.startAfter = dto.startAfter.map((d) => d.getTime()).orUndefined;
    res.repeatInterval = dto.repeatInterval.orUndefined;
    res.cronExpression = dto.cronExpression.orUndefined;
    res.repeatType = dto.repeatType.orUndefined;
    res.maxAttempts = dto.maxAttempts;
    res.attempt = dto.attempt;
    res.payload = dto.payload;
    res.result = dto.result;
    return res;
  }
}

/**
 * Plain JSON representation of {@link TasksResult}.
 */
export class TasksResultView {
  /**
   * Page items converted to plain task views.
   */
  @ApiProperty({ type: TaskView, isArray: true })
  items!: TaskView[];

  /**
   * Total number of matching rows before pagination.
   */
  @ApiProperty()
  total!: number;
}

/**
 * Queue-level percentile statistics used by operational dashboards.
 *
 * Produced by {@link ManageTasksQueueService.waitTimeByQueue} and
 * {@link ManageTasksQueueService.workTimeByQueue}.
 */
export class QueueStat {
  constructor(
    /**
     * Queue name these percentiles belong to.
     */
    readonly queueName: string,
    /**
     * 50th percentile in seconds.
     */
    readonly p50: number,
    /**
     * 75th percentile in seconds.
     */
    readonly p75: number,
    /**
     * 95th percentile in seconds.
     */
    readonly p95: number,
    /**
     * 99th percentile in seconds.
     */
    readonly p99: number,
    /**
     * 99.9th percentile in seconds.
     */
    readonly p999: number,
  ) {}
}

/**
 * Queue/status aggregate used for management dashboards and metrics sync.
 */
export class TasksCount {
  constructor(
    /**
     * Queue name.
     */
    readonly queueName: string,
    /**
     * Task status represented by this count.
     */
    readonly status: TaskStatus,
    /**
     * Number of rows in this queue/status bucket.
     */
    readonly count: number,
  ) {}
}

/**
 * Plain JSON view of {@link QueueStat}.
 */
export class QueueStatView {
  /**
   * Queue name these percentiles belong to.
   */
  @ApiProperty()
  queueName!: string;

  /**
   * 50th percentile in seconds.
   */
  @ApiProperty()
  p50!: number;

  /**
   * 75th percentile in seconds.
   */
  @ApiProperty()
  p75!: number;

  /**
   * 95th percentile in seconds.
   */
  @ApiProperty()
  p95!: number;

  /**
   * 99th percentile in seconds.
   */
  @ApiProperty()
  p99!: number;

  /**
   * 99.9th percentile in seconds.
   */
  @ApiProperty()
  p999!: number;

  /**
   * Convert a queue-stat DTO into a plain API view.
   *
   * @param o queue statistics DTO
   * @returns converted API view
   */
  static fromDto(o: QueueStat) {
    const res = new QueueStatView();
    res.queueName = o.queueName;
    res.p50 = o.p50;
    res.p75 = o.p75;
    res.p95 = o.p95;
    res.p99 = o.p99;
    res.p999 = o.p999;
    return res;
  }
}

/**
 * Plain JSON view of {@link TasksCount}.
 */
export class TasksCountView {
  /**
   * Queue name.
   */
  @ApiProperty()
  queueName!: string;

  /**
   * Task status represented by this count.
   */
  @ApiProperty({ enum: TaskStatus, enumName: "TaskStatus" })
  status!: TaskStatus;

  /**
   * Number of tasks in this queue/status bucket.
   */
  @ApiProperty({ type: "integer" })
  count!: number;

  /**
   * Convert a queue-count DTO into a plain API view.
   *
   * @param o tasks-count DTO
   * @returns converted API view
   */
  static fromDto(o: TasksCount) {
    const res = new TasksCountView();
    res.queueName = o.queueName;
    res.status = o.status;
    res.count = o.count;
    return res;
  }
}

/**
 * Combined queue statistics response shape used by HTTP APIs.
 */
export class QueuesStat {
  /**
   * Queue wait-time percentile stats.
   */
  @ApiProperty({ type: QueueStatView, isArray: true })
  waitTime!: QueueStatView[];

  /**
   * Queue work-time percentile stats.
   */
  @ApiProperty({ type: QueueStatView, isArray: true })
  workTime!: QueueStatView[];

  /**
   * Queue/status task counts.
   */
  @ApiProperty({ type: TasksCountView, isArray: true })
  tasksCount!: TasksCountView[];
}
