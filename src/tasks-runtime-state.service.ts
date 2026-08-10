import { Collection, mutable, Option } from "scats";
import { Clock, SystemClock } from "./clock.js";
import { ScheduledTask } from "./tasks-model.js";
import { TasksPipelineState } from "./tasks-pipeline.js";
import {
  ActiveTaskRuntimeDetails,
  TasksRuntimePoolSnapshot,
  TasksRuntimeSnapshot,
  TasksRuntimeWorkerDetails,
} from "./tasks-runtime.model.js";

interface ActiveTaskStoredDetails {
  taskId: number;
  queueName: string;
  workerClass: string;
  startedAt: number;
  timeoutMs: number;
  currentAttempt: number;
  maxAttempts: number;
  parentTaskId?: number;
  repeatType?: ScheduledTask["repeatType"];
}

interface TasksRuntimePoolSource {
  getStarted: () => boolean;
  getPipelineState: () => TasksPipelineState;
  getRegisteredWorkers: () => TasksRuntimeWorkerDetails[];
}

interface RegisteredRuntimePool {
  name: string;
  loopIntervalMs: number;
  source: TasksRuntimePoolSource;
  activeTasks: mutable.HashMap<number, ActiveTaskStoredDetails>;
}

/**
 * In-memory runtime diagnostics for pools, workers, and currently active tasks.
 */
export class TasksRuntimeStateService {
  private readonly pools = new mutable.HashMap<string, RegisteredRuntimePool>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  registerPool(
    poolName: string,
    loopIntervalMs: number,
    source: TasksRuntimePoolSource,
  ): void {
    this.pools.put(poolName, {
      name: poolName,
      loopIntervalMs,
      source,
      activeTasks: new mutable.HashMap<number, ActiveTaskStoredDetails>(),
    });
  }

  taskStarted(
    poolName: string,
    task: ScheduledTask,
    workerClass: string,
  ): void {
    this.pools.get(poolName).foreach((pool) => {
      pool.activeTasks.put(task.id, {
        taskId: task.id,
        queueName: task.queue,
        workerClass,
        startedAt: task.started.getTime(),
        timeoutMs: task.timeout,
        currentAttempt: task.currentAttempt,
        maxAttempts: task.maxAttempts,
        parentTaskId: task.parentId,
        repeatType: task.repeatType,
      });
    });
  }

  taskFinished(poolName: string, taskId: number): void {
    this.pools.get(poolName).foreach((pool) => {
      pool.activeTasks.remove(taskId);
    });
  }

  getSnapshot(): TasksRuntimeSnapshot {
    const generatedAt = this.clock.now().getTime();
    const queueToPool: Record<string, string> = {};
    const pools = Collection.from(this.pools.entries.toArray)
      .map(([poolName, pool]) => {
        const workersCollection = Collection.from(
          pool.source.getRegisteredWorkers(),
        ).sort((left, right) => left.queueName.localeCompare(right.queueName));
        workersCollection.foreach((worker) => {
          queueToPool[worker.queueName] = poolName;
        });

        const pipelineState = pool.source.getPipelineState();
        const activeTasks = pool.activeTasks.values
          .map(
            (task): ActiveTaskRuntimeDetails => ({
              ...task,
              runningMs: Math.max(0, generatedAt - task.startedAt),
            }),
          )
          .sort((left, right) => {
            if (left.startedAt !== right.startedAt) {
              return left.startedAt - right.startedAt;
            }
            return left.taskId - right.taskId;
          }).toArray;
        const workers = workersCollection.toArray;

        return {
          name: pool.name,
          started: pool.source.getStarted(),
          loopIntervalMs: pool.loopIntervalMs,
          slots: {
            total: pipelineState.maxConcurrentTasks,
            busy: pipelineState.tasksInProcess,
            idle: Math.max(
              0,
              pipelineState.maxConcurrentTasks - pipelineState.tasksInProcess,
            ),
          },
          pipelineState,
          registeredQueues: workers.map((worker) => worker.queueName),
          workers,
          activeTasks,
        } satisfies TasksRuntimePoolSnapshot;
      })
      .sort((left, right) => left.name.localeCompare(right.name)).toArray;

    return {
      generatedAt,
      queueToPool,
      pools,
    };
  }

  getPoolSnapshot(poolName: string): Option<TasksRuntimePoolSnapshot> {
    return this.pools.get(poolName).map(() => {
      const snapshot = this.getSnapshot();
      const matched = snapshot.pools.find((pool) => pool.name === poolName);
      if (matched === undefined) {
        throw new Error(`Runtime snapshot for pool '${poolName}' not found`);
      }
      return matched;
    });
  }
}
