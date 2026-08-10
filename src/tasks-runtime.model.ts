import { TaskPeriodType } from "./tasks-model.js";
import { TasksPipelineState } from "./tasks-pipeline.js";

export interface TasksRuntimeWorkerDetails {
  /** Queue name served by the worker instance. */
  queueName: string;
  /** Runtime class name of the registered worker implementation. */
  workerClass: string;
}

export interface ActiveTaskRuntimeDetails {
  /** Persistent task id currently executing in this process. */
  taskId: number;
  /** Queue name the active task belongs to. */
  queueName: string;
  /** Runtime class name of the worker processing the task. */
  workerClass: string;
  /** Attempt start time as Unix timestamp in milliseconds. */
  startedAt: number;
  /** Time in milliseconds since the current attempt started. */
  runningMs: number;
  /** Configured timeout for the current attempt in milliseconds. */
  timeoutMs: number;
  /** Current attempt number starting from 1. */
  currentAttempt: number;
  /** Maximum number of attempts allowed for the task. */
  maxAttempts: number;
  /** Parent task id when the task was spawned as a child task. */
  parentTaskId?: number;
  /** Periodic scheduling mode for periodic tasks, if applicable. */
  repeatType?: TaskPeriodType;
}

export interface TasksRuntimeSlotsSnapshot {
  /** Configured concurrency for the pool. */
  total: number;
  /** Number of slots currently occupied by in-flight tasks. */
  busy: number;
  /** Number of currently free processing slots. */
  idle: number;
}

export interface TasksRuntimePoolSnapshot {
  /** Pool name as configured in module options. */
  name: string;
  /** Whether the pool worker loop has been started in this process. */
  started: boolean;
  /** Fallback polling interval for the pool in milliseconds. */
  loopIntervalMs: number;
  /** Current slot usage summary for the pool. */
  slots: TasksRuntimeSlotsSnapshot;
  /** Low-level polling loop state captured from the pipeline. */
  pipelineState: TasksPipelineState;
  /** Sorted list of queue names registered in the pool. */
  registeredQueues: string[];
  /** Registered worker descriptors for queues in the pool. */
  workers: TasksRuntimeWorkerDetails[];
  /** Tasks currently executing in this process for the pool. */
  activeTasks: ActiveTaskRuntimeDetails[];
}

export interface TasksRuntimeSnapshot {
  /** Snapshot generation time as Unix timestamp in milliseconds. */
  generatedAt: number;
  /** Reverse lookup from queue name to owning pool name. */
  queueToPool: Record<string, string>;
  /** Sorted list of runtime pool snapshots for the current process. */
  pools: TasksRuntimePoolSnapshot[];
}
