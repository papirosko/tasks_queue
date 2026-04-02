import { mutable, none, option, Option, some, Try } from "scats";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { MetricsService } from "application-metrics";
import { TasksPipeline } from "./tasks-pipeline.js";
import {
  ScheduleTaskDetails,
  ScheduledTask,
  TASK_HEARTBEAT_THROTTLE_MS,
  TaskContext,
  TaskFailed,
  TaskStateSnapshot,
  TaskStatus,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { TimeUtils } from "./time-utils.js";

const logger = log4js.getLogger("TasksQueueWorker");

class RuntimeTaskContext implements TaskContext {
  private childTask: Option<ScheduleTaskDetails> = none;
  private _nextPayload: Option<object> = none;
  private lastPingAt: Option<number> = none;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    readonly taskId: number,
    readonly currentAttempt: number,
    readonly maxAttempts: number,
  ) {}

  async ping(): Promise<void> {
    const now = Date.now();
    if (this.lastPingAt
      .map((lastPingAt) => now - lastPingAt < TASK_HEARTBEAT_THROTTLE_MS)
      .getOrElseValue(false)) {
      return;
    }
    await this.tasksQueueDao.ping(this.taskId);
    this.lastPingAt = some(now);
  }

  spawnChild(task: ScheduleTaskDetails): void {
    if (this.childTask.nonEmpty) {
      throw new Error(
        `Task ${this.taskId} attempted to spawn more than one child task`,
      );
    }
    this.childTask = some(task);
  }

  setPayload(payload: object): void {
    this._nextPayload = some(payload);
  }

  async findTask(taskId: number): Promise<Option<TaskStateSnapshot>> {
    return this.tasksQueueDao.findTaskState(taskId);
  }

  get spawnedChild(): Option<ScheduleTaskDetails> {
    return this.childTask;
  }

  payloadToPersist(currentPayload: object | undefined): object {
    return this._nextPayload.getOrElseValue(currentPayload ?? {});
  }

  get nextPayload(): Option<object> {
    return this._nextPayload;
  }
}

export class TasksQueueWorker {
  private readonly workers = new mutable.HashMap<string, TasksWorker>();
  private readonly pipeline: TasksPipeline;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    concurrency = 4,
    loopInterval: number = TimeUtils.minute,
  ) {
    this.pipeline = new TasksPipeline(
      concurrency,
      () => this.tasksQueueDao.nextPending(this.workers.keySet),
      () => this.tasksQueueDao.peekNextStartAfter(this.workers.keySet),
      (t) => this.processNextTask(t),
      loopInterval,
    );
  }

  start(): void {
    this.pipeline.start();
  }

  stop() {
    return this.pipeline.stop();
  }

  registerWorker(queueName: string, worker: TasksWorker): void {
    if (this.workers.containsKey(queueName)) {
      logger.warn(`Replacing existing worker for queue: ${queueName}`);
    }
    this.workers.put(queueName, worker);
  }

  tasksScheduled(queueName: string): void {
    if (this.workers.containsKey(queueName)) {
      // Wake up the loop to check for pending tasks
      this.pipeline.triggerLoop();
    }
  }

  /**
   * Wake a blocked parent task after a child has reached a terminal state and notify its queue.
   *
   * @param childTaskId child task id
   */
  private async wakeBlockedParent(childTaskId: number): Promise<void> {
    const parent =
      await this.tasksQueueDao.wakeParentOnChildTerminal(childTaskId);
    parent.foreach((p) => this.tasksScheduled(p.queue));
  }

  /**
   * Persist a successful task outcome based on runtime orchestration state.
   *
   * The method handles child spawning, one-time task finishing, and periodic rescheduling.
   *
   * @param task current scheduled task
   * @param context runtime task context
   */
  private async persistSuccessfulOutcome(
    task: ScheduledTask,
    context: RuntimeTaskContext,
  ): Promise<void> {
    await context.spawnedChild.match({
      some: async (spawnedChild) => {
        option(task.repeatType).foreach(() => {
          throw new Error(`Periodic task ${task.id} cannot spawn child tasks`);
        });
        const childTaskId =
          await this.tasksQueueDao.blockParentAndScheduleChild(
            task.id,
            spawnedChild,
            context.payloadToPersist(task.payload),
          );
        childTaskId.foreach(() => this.tasksScheduled(spawnedChild.queue));
      },
      none: async () => {
        await option(task.repeatType).match({
          some: async () => {
            await this.tasksQueueDao.rescheduleIfPeriodic(
              task.id,
              context.nextPayload.orUndefined,
            );
          },
          none: async () => {
            await this.tasksQueueDao.finish(
              task.id,
              context.nextPayload.orUndefined,
            );
            await this.wakeBlockedParent(task.id);
          },
        });
      },
    });
  }

  private async processNextTask(task: ScheduledTask): Promise<void> {
    MetricsService.counter("tasks_queue_started").inc();
    await this.workers.get(task.queue).match({
      some: async (worker) => {
        const context = new RuntimeTaskContext(
          this.tasksQueueDao,
          task.id,
          task.currentAttempt,
          task.maxAttempts,
        );
        try {
          Try(() => worker.starting(task.id, task.payload)).tapFailure((e) =>
            logger.warn(
              `Failed to invoke 'starting' callback for task (id=${task.id}) in queue=${task.queue}`,
              e,
            ),
          );
          await worker.process(task.payload, context);
          await this.persistSuccessfulOutcome(task, context);
          MetricsService.counter("tasks_queue_processed").inc();
          (
            await Try.promise(() => worker.completed(task.id, task.payload))
          ).tapFailure((e) =>
            logger.warn(
              `Failed to invoke 'completed' callback for task (id=${task.id}) in queue=${task.queue}`,
              e,
            ),
          );
        } catch (e) {
          const finalStatus = await this.tasksQueueDao.fail(
            task.id,
            (e as any)["message"] || e,
            e instanceof TaskFailed ? e.payload : task.payload,
          );
          if (finalStatus === TaskStatus.error) {
            await this.wakeBlockedParent(task.id);
          }
          (
            await Try.promise(() =>
              worker.failed(task.id, task.payload, finalStatus, e),
            )
          ).tapFailure((e) =>
            logger.warn(
              `Failed to invoke 'failed' callback for task (id=${task.id}) in queue=${task.queue}`,
              e,
            ),
          );
          MetricsService.counter("tasks_queue_failed").inc();
          logger.warn(
            `Failed to process task (id=${task.id}) in queue=${task.queue}`,
            e,
          );
        }
      },
      none: async () => {
        MetricsService.counter("tasks_queue_skipped_no_worker").inc();
        logger.info(
          `Failed to process task (id=${task.id}) in queue=${task.queue}: no suitable worker found`,
        );
      },
    });
  }
}
