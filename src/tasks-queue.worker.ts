import { mutable, none, option, Option, some, Try } from "scats";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { MetricsService } from "application-metrics";
import { TasksPipeline } from "./tasks-pipeline.js";
import {
  ScheduledTask,
  SpawnChildTaskDetails,
  TASK_HEARTBEAT_THROTTLE_MS,
  TaskContext,
  TaskFailed,
  TaskStateSnapshot,
  TaskStatus,
  TaskTimedOutError,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { TimeUtils } from "./time-utils.js";
import { Clock, SystemClock } from "./clock.js";

const logger = log4js.getLogger("TasksQueueWorker");

class RuntimeTaskContext implements TaskContext {
  private childTask: Option<SpawnChildTaskDetails> = none;
  private _nextPayload: Option<object> = none;
  private _submittedResult: Option<object> = none;
  private readonly attemptStartedAt: Date;
  private lastHeartbeatAt: Option<number> = none;
  resolvedChildTask: Option<TaskStateSnapshot> = none;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    readonly taskId: number,
    readonly startedAt: Date,
    readonly currentAttempt: number,
    readonly maxAttempts: number,
    private readonly timeout: number,
    private readonly clock: Clock,
  ) {
    this.attemptStartedAt = new Date(startedAt);
  }

  async ensureNotStalled(): Promise<void> {
    const now = this.clock.now();
    if (
      now.getTime() -
        this.lastHeartbeatAt.getOrElseValue(this.attemptStartedAt.getTime()) <=
      this.timeout
    ) {
      return;
    }

    const finalStatus = (
      await this.tasksQueueDao.failIfStalled(
        this.taskId,
        this.attemptStartedAt,
        now,
      )
    ).getOrElseValue(TaskStatus.error);
    throw new TaskTimedOutError(this.taskId, finalStatus);
  }

  async ping(): Promise<void> {
    await this.ensureNotStalled();
    const now = this.clock.now().getTime();
    if (
      this.lastHeartbeatAt
        .map((lastHeartbeatAt) => now - lastHeartbeatAt < TASK_HEARTBEAT_THROTTLE_MS)
        .getOrElseValue(false)
    ) {
      return;
    }
    const persisted = await this.tasksQueueDao.ping(
      this.taskId,
      this.attemptStartedAt,
      this.clock.now(),
    );
    if (!persisted) {
      throw new Error(`Task ${this.taskId} execution is no longer active`);
    }
    this.lastHeartbeatAt = some(now);
  }

  spawnChild(task: SpawnChildTaskDetails): void {
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

  submitResult(result: object): void {
    this._submittedResult = some(result);
  }

  async findTask(taskId: number): Promise<Option<TaskStateSnapshot>> {
    return this.tasksQueueDao.findTaskState(taskId);
  }

  get spawnedChild(): Option<SpawnChildTaskDetails> {
    return this.childTask;
  }

  payloadToPersist(currentPayload: object | undefined): object {
    return this._nextPayload.getOrElseValue(currentPayload ?? {});
  }

  get nextPayload(): Option<object> {
    return this._nextPayload;
  }

  get submittedResult(): Option<object> {
    return this._submittedResult;
  }
}

export class TasksQueueWorker {
  private readonly workers = new mutable.HashMap<string, TasksWorker>();
  private readonly pipeline: TasksPipeline;
  private started = false;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    concurrency = 4,
    loopInterval: number = TimeUtils.minute,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.pipeline = new TasksPipeline(
      concurrency,
      () => this.tasksQueueDao.nextPending(this.workers.keySet, this.clock.now()),
      () =>
        this.tasksQueueDao.peekNextStartAfter(
          this.workers.keySet,
          this.clock.now(),
        ),
      (t) => this.processNextTask(t),
      loopInterval,
      this.clock,
    );
  }

  start(): void {
    this.started = true;
    this.pipeline.start();
  }

  async stop() {
    this.started = false;
    return await this.pipeline.stop();
  }

  async runOnce(): Promise<void> {
    const task = await this.tasksQueueDao.nextPending(
      this.workers.keySet,
      this.clock.now(),
    );
    await task.mapPromise(async (scheduledTask) => {
      await this.processNextTask(scheduledTask);
      return scheduledTask;
    });
  }

  registerWorker(queueName: string, worker: TasksWorker): void {
    if (this.workers.containsKey(queueName)) {
      logger.warn(`Replacing existing worker for queue: ${queueName}`);
    }
    this.workers.put(queueName, worker);
  }

  tasksScheduled(queueName: string): void {
    if (this.started && this.workers.containsKey(queueName)) {
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
    const parent = await this.tasksQueueDao.wakeParentOnChildTerminal(
      childTaskId,
      this.clock.now(),
    );
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
  ): Promise<boolean> {
    await context.ensureNotStalled();
    return await context.spawnedChild.match({
      some: async (spawnedChild) => {
        option(task.repeatType).foreach(() => {
          throw new Error(`Periodic task ${task.id} cannot spawn child tasks`);
        });
        const childTaskId =
          await this.tasksQueueDao.blockParentAndScheduleChild(
            task.id,
            spawnedChild,
            context.payloadToPersist(task.payload),
            task.started,
            this.clock.now(),
          );
        childTaskId.foreach(() => this.tasksScheduled(spawnedChild.queue));
        return childTaskId.isDefined;
      },
      none: async () => {
        return await option(task.repeatType).match({
          some: async () => {
            return await this.tasksQueueDao.rescheduleIfPeriodic(
              task.id,
              context.payloadToPersist(task.payload),
              context.submittedResult.orUndefined,
              task.started,
              this.clock.now(),
            );
          },
          none: async () => {
            const finished = await this.tasksQueueDao.finish(
              task.id,
              context.payloadToPersist(task.payload),
              context.submittedResult.orUndefined,
              task.started,
              this.clock.now(),
            );
            if (finished) {
              await this.wakeBlockedParent(task.id);
            }
            return finished;
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
          task.started,
          task.currentAttempt,
          task.maxAttempts,
          task.timeout,
          this.clock,
        );
        try {
          Try(() => worker.starting(task.id, task.payload)).tapFailure((e) =>
            logger.warn(
              `Failed to invoke 'starting' callback for task (id=${task.id}) in queue=${task.queue}`,
              e,
            ),
          );
          await worker.process(task.payload, context);
          const persisted = await this.persistSuccessfulOutcome(task, context);
          if (!persisted) {
            logger.info(
              `Skipping completion for task (id=${task.id}) in queue=${task.queue}: execution ownership was lost`,
            );
            return;
          }
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
          const finalStatus =
            e instanceof TaskTimedOutError
              ? e.finalStatus
              : (
                  await this.tasksQueueDao.fail(
                  task.id,
                  (e as any)["message"] || e,
                  e instanceof TaskFailed ? e.payload : task.payload,
                  context.submittedResult.orUndefined,
                  task.started,
                  this.clock.now(),
                )
              ).getOrElseValue(TaskStatus.error);
          if (
            finalStatus === TaskStatus.error &&
            !(e instanceof TaskTimedOutError)
          ) {
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
