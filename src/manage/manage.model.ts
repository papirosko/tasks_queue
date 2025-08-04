import { Collection, Option } from "scats";
import { ApiProperty } from "@nestjs/swagger";
import {
  BackoffType,
  MissedRunStrategy,
  TaskPeriodType,
  TaskStatus,
} from "../tasks-model";

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
