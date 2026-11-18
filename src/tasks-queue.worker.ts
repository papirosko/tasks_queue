import { Collection, mutable, none, option, Option, some, Try } from "scats";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { MetricsService } from "application-metrics";
import {
  ScheduledTask,
  SpawnChildTaskDetails,
  TaskContext,
  TaskFailed,
  taskHeartbeatThrottleMs,
  TaskStateSnapshot,
  TaskStatus,
  TaskTimedOutError,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { TimeUtils } from "./time-utils.js";
import { Clock, SystemClock } from "./clock.js";
import { poolMetricName, queueMetricName } from "./metrics-utils.js";
import { TasksRuntimeStateService } from "./tasks-runtime-state.service.js";
import { TasksRuntimeWorkerDetails } from "./tasks-runtime.model.js";
import { TasksPipeline, TasksPipelineState } from "./tasks-pipeline.js";

const logger = log4js.getLogger("TasksQueueWorker");

class RuntimeTaskContext implements TaskContext {
  private readonly abortController = new AbortController();
  readonly signal = this.abortController.signal;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.scheduleTimeoutCheck(this.timeout + 1);
  }

  dispose(): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private scheduleTimeoutCheck(delay: number): void {
    if (this.signal.aborted) {
      return;
    }
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
    }

    this.timeoutTimer = setTimeout(
      () => {
        this.timeoutTimer = null;
        void this.checkTimeout();
      },
      Math.min(Math.max(1, delay), 2_147_483_647),
    );
    this.timeoutTimer.unref();
  }

  private async checkTimeout(): Promise<void> {
    try {
      await this.ensureNotStalled();
      this.scheduleTimeoutCheck(this.timeout + 1);
    } catch (error) {
      if (error instanceof TaskTimedOutError) {
        this.abortController.abort(error);
        return;
      }
      logger.warn(`Failed to check timeout for task ${this.taskId}`, error);
      this.scheduleTimeoutCheck(1000);
    }
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
    const timeoutError = new TaskTimedOutError(this.taskId, finalStatus);
    this.abortController.abort(timeoutError);
    this.dispose();
    throw timeoutError;
  }

  async ping(): Promise<void> {
    await this.ensureNotStalled();
    const now = this.clock.now().getTime();
    if (
      this.lastHeartbeatAt
        .map(
          (lastHeartbeatAt) =>
            now - lastHeartbeatAt < taskHeartbeatThrottleMs(this.timeout),
        )
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
    this.scheduleTimeoutCheck(this.timeout + 1);
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
    return this._nextPayload.getOrElseValue(
      option(currentPayload).getOrElseValue({}),
    );
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
  private readonly queueNotifier: (queueName: string) => void;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    concurrency = 4,
    loopInterval: number = TimeUtils.minute,
    private readonly clock: Clock = new SystemClock(),
    queueNotifier?: (queueName: string) => void,
    private readonly poolName: string = "default",
    private readonly runtimeStateService?: TasksRuntimeStateService,
  ) {
    this.queueNotifier = option(queueNotifier).getOrElse(
      () => (queueName) => this.tasksScheduled(queueName),
    );
    this.pipeline = new TasksPipeline(
      concurrency,
      () => this.pollNextTask(),
      () =>
        this.tasksQueueDao.peekNextStartAfter(
          this.workers.keySet,
          this.clock.now(),
        ),
      (t) => this.processNextTask(t),
      loopInterval,
      this.clock,
      this.poolName,
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
    const task = await this.pollNextTask();
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
    this.updatePoolQueuesLabel();
  }

  getPipelineState(): TasksPipelineState {
    return this.pipeline.getState();
  }

  getRegisteredWorkers(): TasksRuntimeWorkerDetails[] {
    return Collection.from(this.workers.entries.toArray)
      .map(([queueName, worker]) => ({
        queueName,
        workerClass: this.workerClassName(worker),
      }))
      .sort((left, right) => left.queueName.localeCompare(right.queueName))
      .toArray;
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
    parent.foreach((p) => this.queueNotifier(p.queue));
  }

  private async pollNextTask(): Promise<Option<ScheduledTask>> {
    this.updatePoolQueuesLabel();
    this.workers.keySet.foreach((queueName) => {
      MetricsService.counter(queueMetricName(queueName, "poll_total")).inc();
    });
    const task = await this.tasksQueueDao.nextPending(
      this.workers.keySet,
      this.clock.now(),
    );
    task.foreach((scheduledTask) => {
      MetricsService.counter(
        queueMetricName(scheduledTask.queue, "fetched_total"),
      ).inc();
    });
    return task;
  }

  private updatePoolQueuesLabel(): void {
    MetricsService.label(
      poolMetricName(this.poolName, "queues"),
      Collection.from(this.workers.keySet.toArray)
        .sort((a, b) => a.localeCompare(b))
        .mkString(","),
    );
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
    try {
      return await context.spawnedChild.match({
        some: async (spawnedChild) => {
          option(task.repeatType).foreach(() => {
            throw new Error(
              `Periodic task ${task.id} cannot spawn child tasks`,
            );
          });
          const childTaskId =
            await this.tasksQueueDao.blockParentAndScheduleChild(
              task.id,
              spawnedChild,
              context.payloadToPersist(task.payload),
              task.started,
              this.clock.now(),
            );
          childTaskId.foreach(() => this.queueNotifier(spawnedChild.queue));
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
    } finally {
      context.dispose();
    }
  }

  private async processNextTask(task: ScheduledTask): Promise<void> {
    MetricsService.counter("tasks_queue_started").inc();
    await this.workers.get(task.queue).match({
      some: async (worker) => {
        MetricsService.counter(
          queueMetricName(task.queue, "task_started_total"),
        ).inc();
        const workerClass = this.workerClassName(worker);
        option(this.runtimeStateService).foreach((runtimeStateService) => {
          runtimeStateService.taskStarted(this.poolName, task, workerClass);
        });
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
          MetricsService.counter(
            queueMetricName(task.queue, "task_finished_total"),
          ).inc();
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
          MetricsService.counter(
            queueMetricName(task.queue, `task_failed_${finalStatus}_total`),
          ).inc();
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
        } finally {
          context.dispose();
          option(this.runtimeStateService).foreach((runtimeStateService) => {
            runtimeStateService.taskFinished(this.poolName, task.id);
          });
        }
      },
      none: async () => {
        MetricsService.counter("tasks_queue_skipped_no_worker").inc();
        MetricsService.counter(
          queueMetricName(task.queue, "task_skipped_no_worker_total"),
        ).inc();
        logger.info(
          `Failed to process task (id=${task.id}) in queue=${task.queue}: no suitable worker found`,
        );
      },
    });
  }

  private workerClassName(worker: TasksWorker): string {
    return option(worker.constructor)
      .flatMap((constructor) => option(constructor.name))
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .getOrElseValue("AnonymousTasksWorker");
  }
}
