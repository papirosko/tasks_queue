import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { TasksQueueWorker } from "./tasks-queue.worker.js";
import { TasksAuxiliaryWorker } from "./tasks-auxiliary-worker.js";
import { none, Option, some } from "scats";
import {
  ScheduleCronTaskDetails,
  SchedulePeriodicTaskDetails,
  ScheduleTaskDetails,
  TaskPeriodType,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { ManageTasksQueueService } from "./manage-tasks-queue.service.js";
import { Clock, SystemClock } from "./clock.js";

const logger = log4js.getLogger("TasksQueueService");

export interface TasksQueueConfig {
  /**
   * Maximum number of tasks that may run concurrently in this service instance.
   */
  concurrency: number;
  /**
   * Whether to run the background auxiliary worker for stalled-task handling,
   * failed-task reset, finished-task cleanup, and metrics sync.
   */
  runAuxiliaryWorker: boolean;
  /**
   * Fallback polling interval in milliseconds for the worker pipeline.
   */
  loopInterval: number;
}

/**
 * Service for scheduling tasks and controlling queue workers in a single-pool setup.
 *
 * Periodic scheduling is supported via:
 * - fixed rate
 * - fixed delay
 * - cron expressions
 *
 * Cron expressions are interpreted in UTC by default in the current implementation.
 */
export class TasksQueueService {
  private readonly worker: TasksQueueWorker;
  private readonly auxiliaryWorker: Option<TasksAuxiliaryWorker>;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    manageTasksQueueService: ManageTasksQueueService,
    config: TasksQueueConfig,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.worker = new TasksQueueWorker(
      this.tasksQueueDao,
      config.concurrency,
      config.loopInterval,
      this.clock,
    );
    if (config.runAuxiliaryWorker) {
      this.auxiliaryWorker = some(
        new TasksAuxiliaryWorker(
          tasksQueueDao,
          manageTasksQueueService,
          this.clock,
        ),
      );
    } else {
      this.auxiliaryWorker = none;
    }
  }

  /**
   * Schedule a one-time task for execution.
   *
   * The task is stored in the queue and processed once by a registered worker.
   * After successful persistence, the worker loop is nudged to reduce latency.
   *
   * @param task one-time task details
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async schedule(task: ScheduleTaskDetails) {
    const taskId = await this.tasksQueueDao.schedule(task, this.clock.now());
    this.taskScheduled(task.queue);
    return taskId;
  }

  /**
   * Schedule a periodic task with fixed-rate semantics.
   *
   * Fixed-rate means the next execution time is aligned to the configured period
   * regardless of task processing duration.
   *
   * @param task periodic task details with `period` in milliseconds
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async scheduleAtFixedRate(task: SchedulePeriodicTaskDetails) {
    const taskId = await this.tasksQueueDao.schedulePeriodic(
      task,
      TaskPeriodType.fixed_rate,
      this.clock.now(),
    );
    this.taskScheduled(task.queue);
    return taskId;
  }

  /**
   * Schedule a periodic task with fixed-delay semantics.
   *
   * Fixed-delay means the next execution is calculated as `now + period`
   * after the current run has finished.
   *
   * @param task periodic task details with `period` in milliseconds
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async scheduleAtFixedDelay(task: SchedulePeriodicTaskDetails) {
    const taskId = await this.tasksQueueDao.schedulePeriodic(
      task,
      TaskPeriodType.fixed_delay,
      this.clock.now(),
    );
    this.taskScheduled(task.queue);
    return taskId;
  }

  /**
   * Schedule a periodic task using a cron expression.
   *
   * Supported cron formats:
   * - 5 fields: minute, hour, day-of-month, month, day-of-week
   * - 6 fields: second, minute, hour, day-of-month, month, day-of-week
   *
   * The expression is validated before persistence in the DAO layer.
   * Cron schedule calculations currently use UTC timezone.
   *
   * @param task cron task details including `cronExpression`
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async scheduleAtCron(task: ScheduleCronTaskDetails) {
    const taskId = await this.tasksQueueDao.schedulePeriodic(
      task,
      TaskPeriodType.cron,
      this.clock.now(),
    );
    this.taskScheduled(task.queue);
    return taskId;
  }

  /**
   * Notify internal polling loop that a task was scheduled for the given queue.
   *
   * @param queueName queue identifier
   * @returns nothing; if the service is already started, the polling loop is nudged immediately
   */
  taskScheduled(queueName: string): void {
    this.worker.tasksScheduled(queueName);
  }

  /**
   * Register a worker implementation for the queue.
   *
   * @param queueName queue identifier
   * @param worker queue worker instance
   * @returns nothing; the worker becomes eligible to receive future tasks from this queue
   */
  registerWorker(queueName: string, worker: TasksWorker) {
    this.worker.registerWorker(queueName, worker);
  }

  /**
   * Run at most one eligible task-processing cycle synchronously.
   *
   * This method is mainly useful in tests or in applications that want manual
   * control over queue polling. It respects the same ownership, timeout, retry,
   * and periodic semantics as the background loop.
   *
   * @returns resolved promise after the current cycle completes
   */
  async runOnce(): Promise<void> {
    await this.worker.runOnce();
  }

  /**
   * Start processing loops.
   *
   * Starts the main worker and, if enabled, the auxiliary worker responsible
   * for maintenance tasks.
   *
   * See also {@link stop}.
   */
  start() {
    try {
      this.worker.start();
      this.auxiliaryWorker.foreach((w) => w.start());
    } catch (e) {
      logger.warn("Failed to process stalled tasks", e);
    }
  }

  /**
   * Stop processing loops gracefully.
   *
   * The method stops auxiliary processing first and then waits for the main
   * worker pipeline to finish in-flight tasks.
   *
   * @returns resolved promise once the service has stopped
   */
  async stop() {
    this.auxiliaryWorker.foreach((w) => w.stop());
    await this.worker.stop();
  }
}
