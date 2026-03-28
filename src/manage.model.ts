import { Collection, Option } from "scats";
import { ApiProperty } from "@nestjs/swagger";
import {
  BackoffType,
  MissedRunStrategy,
  TaskPeriodType,
  TaskStatus,
} from "./tasks-model.js";

export class TaskDto {
  constructor(
    readonly id: number,
    readonly queue: string,
    readonly created: Date,
    readonly initialStart: Date,
    readonly started: Option<Date>,
    readonly finished: Option<Date>,
    readonly status: TaskStatus,
    readonly missedRunStrategy: MissedRunStrategy,
    readonly priority: number,
    readonly error: Option<string>,
    readonly backoff: number,
    readonly backoffType: BackoffType,
    readonly timeout: number,
    readonly name: Option<string>,
    readonly startAfter: Option<Date>,
    readonly repeatInterval: Option<number>,
    readonly cronExpression: Option<string>,
    readonly repeatType: Option<TaskPeriodType>,
    readonly maxAttempts: number,
    readonly attempt: number,
    readonly payload: any,
  ) {}
}

export class TasksResult {
  constructor(
    readonly items: Collection<TaskDto>,
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

export class TaskView {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  queue!: string;

  @ApiProperty()
  created!: number;

  @ApiProperty()
  initialStart!: number;

  @ApiProperty({ required: false })
  started?: number;

  @ApiProperty({ required: false })
  finished?: number;

  @ApiProperty()
  status!: TaskStatus;

  @ApiProperty()
  missedRunStrategy!: MissedRunStrategy;

  @ApiProperty()
  priority!: number;

  @ApiProperty({ required: false })
  error?: string;

  @ApiProperty()
  backoff!: number;

  @ApiProperty()
  backoffType!: BackoffType;

  @ApiProperty()
  timeout!: number;

  @ApiProperty({ required: false })
  name?: string;

  @ApiProperty()
  startAfter?: number;

  @ApiProperty()
  repeatInterval?: number;

  @ApiProperty()
  cronExpression?: string;

  @ApiProperty()
  repeatType?: TaskPeriodType;

  @ApiProperty()
  maxAttempts!: number;

  @ApiProperty()
  attempt!: number;

  @ApiProperty()
  payload: any;

  static fromDto(dto: TaskDto) {
    const res = new TaskView();
    res.id = dto.id;
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
    return res;
  }
}

export class TasksResultView {
  @ApiProperty({ type: TaskView, isArray: true })
  items!: TaskView[];

  @ApiProperty()
  total!: number;
}

export class QueueStat {
  constructor(
    readonly queueName: string,
    readonly p50: number,
    readonly p75: number,
    readonly p95: number,
    readonly p99: number,
    readonly p999: number,
  ) {}
}

export class TasksCount {
  constructor(
    readonly queueName: string,
    readonly status: TaskStatus,
    readonly count: number,
  ) {}
}

export class QueueStatView {
  @ApiProperty()
  queueName!: string;

  @ApiProperty()
  p50!: number;

  @ApiProperty()
  p75!: number;

  @ApiProperty()
  p95!: number;

  @ApiProperty()
  p99!: number;

  @ApiProperty()
  p999!: number;

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

export class TasksCountView {
  @ApiProperty()
  queueName!: string;

  @ApiProperty({ enum: TaskStatus, enumName: "TaskStatus" })
  status!: TaskStatus;

  @ApiProperty({ type: "integer" })
  count!: number;

  static fromDto(o: TasksCount) {
    const res = new TasksCountView();
    res.queueName = o.queueName;
    res.status = o.status;
    res.count = o.count;
    return res;
  }
}

export class QueuesStat {
  @ApiProperty({ type: QueueStatView, isArray: true })
  waitTime!: QueueStatView[];

  @ApiProperty({ type: QueueStatView, isArray: true })
  workTime!: QueueStatView[];

  @ApiProperty({ type: TasksCountView, isArray: true })
  tasksCount!: TasksCountView[];
}
