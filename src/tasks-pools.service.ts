import { TasksPool } from "./tasks-pool.js";
import { Collection, HashMap, mutable, none, Option, some } from "scats";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import { TasksQueueService } from "./tasks-queue.service.js";
import { TasksAuxiliaryWorker } from "./tasks-auxiliary-worker.js";
import log4js from "log4js";
import {
  ScheduleCronTaskDetails,
  SchedulePeriodicTaskDetails,
  ScheduleTaskDetails,
  TaskPeriodType,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { ManageTasksQueueService } from "./manage-tasks-queue.service.js";
import { Clock, SystemClock } from "./clock.js";

export const DEFAULT_POOL = "default";
const logger = log4js.getLogger("TasksPoolsService");

/**
 * Service that manages multiple task-processing pools and routes queue events to them.
 *
 * Periodic scheduling supports fixed rate, fixed delay, and cron expressions.
 * Cron schedules are currently evaluated in UTC timezone.
 */
export class TasksPoolsService {
  private readonly pools: HashMap<string, TasksQueueService>;
  private readonly queuesPool = new mutable.HashMap<string, string>();
  private readonly auxiliaryWorker: Option<TasksAuxiliaryWorker>;

  constructor(
    private readonly dao: TasksQueueDao,
    manageTasksQueueService: ManageTasksQueueService,
    runAuxiliaryWorker: boolean,
    pools: TasksPool[] = [
      {
        name: DEFAULT_POOL,
        concurrency: 1,
        loopInterval: 60000,
      },
    ],
    private readonly clock: Clock = new SystemClock(),
  ) {
    const poolsCollection = Collection.from(pools);
    const poolNames = poolsCollection.map((p) => p.name).toSet;
    if (poolsCollection.size !== poolNames.size) {
      throw new Error("Duplicate pool names detected");
    }
    this.pools = poolsCollection.toMap((p) => [
      p.name,
      new TasksQueueService(dao, manageTasksQueueService, {
        concurrency: p.concurrency,
        runAuxiliaryWorker: false,
        loopInterval: p.loopInterval,
      }, this.clock),
    ]);
    this.auxiliaryWorker = runAuxiliaryWorker
      ? some(new TasksAuxiliaryWorker(dao, manageTasksQueueService, this.clock))
      : none;
  }

  /**
   * Start all configured pools and optional auxiliary worker.
   *
   * Each pool starts its own polling pipeline with its configured concurrency
   * and loop interval.
   */
  start() {
    logger.info(`Starting TasksPoolsService with ${this.pools.size} pools`);
    this.auxiliaryWorker.foreach((w) => w.start());
    this.pools.values.foreach((p) => p.start());
  }

  /**
   * Stop all pools gracefully.
   *
   * The method races pool shutdown against a timeout to avoid hanging forever.
   *
   * @param timeoutMs maximum time to wait for graceful stop
   */
  async stop(timeoutMs = 30000) {
    logger.info("Stopping TasksPoolsService");
    try {
      this.auxiliaryWorker.foreach((w) => w.stop());
      await Promise.race([
        this.pools.values.mapPromise((p) => p.stop()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Stop timeout")), timeoutMs),
        ),
      ]);
      logger.info("TasksPoolsService stopped successfully");
    } catch (e) {
      logger.error("Failed to stop TasksPoolsService gracefully", e);
      throw e;
    }
  }

  /**
   * Register a queue worker in the selected pool.
   *
   * A queue can be bound to only one pool. Attempting to register the same
   * queue twice throws an error.
   *
   * @param queueName queue identifier
   * @param worker worker implementation
   * @param poolName target pool name, defaults to `default`
   */
  registerWorker(
    queueName: string,
    worker: TasksWorker,
    poolName: string = DEFAULT_POOL,
  ): void {
    if (this.queuesPool.containsKey(queueName)) {
      throw new Error(
        `Queue '${queueName}' is already registered in pool '${this.queuesPool.get(queueName).getOrElseValue("unknown")}'`,
      );
    }
    this.pools.get(poolName).match({
      some: (pool) => {
        pool.registerWorker(queueName, worker);
        this.queuesPool.put(queueName, poolName);
        logger.info(
          `Registered worker for queue '${queueName}' in pool '${poolName}'`,
        );
      },
      none: () => {
        throw new Error(`Pool '${poolName}' not registered`);
      },
    });
  }

  /**
   * Schedule a one-time task.
   *
   * After persistence, the task notification is routed to the pool where
   * the queue worker is registered.
   *
   * @param task one-time task details
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async schedule(task: ScheduleTaskDetails) {
    const taskId = await this.dao.schedule(task, this.clock.now());
    this.taskScheduled(task.queue, taskId);
    return taskId;
  }

  /**
   * Schedule a periodic task with fixed-rate semantics.
   *
   * @param task periodic task details with `period` in milliseconds
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async scheduleAtFixedRate(task: SchedulePeriodicTaskDetails) {
    const taskId = await this.dao.schedulePeriodic(
      task,
      TaskPeriodType.fixed_rate,
      this.clock.now(),
    );
    this.taskScheduled(task.queue, taskId);
    return taskId;
  }

  /**
   * Schedule a periodic task with fixed-delay semantics.
   *
   * @param task periodic task details with `period` in milliseconds
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async scheduleAtFixedDelay(task: SchedulePeriodicTaskDetails) {
    const taskId = await this.dao.schedulePeriodic(
      task,
      TaskPeriodType.fixed_delay,
      this.clock.now(),
    );
    this.taskScheduled(task.queue, taskId);
    return taskId;
  }

  /**
   * Schedule a periodic task by cron expression.
   *
   * Supported formats:
   * - 5 fields: minute, hour, day-of-month, month, day-of-week
   * - 6 fields: second, minute, hour, day-of-month, month, day-of-week
   *
   * Cron expression validation is performed in DAO before insert.
   * Cron schedule calculations currently use UTC timezone.
   *
   * @param task cron task details
   * @returns created task id if insert succeeded, otherwise `none`
   */
  async scheduleAtCron(task: ScheduleCronTaskDetails) {
    const taskId = await this.dao.schedulePeriodic(
      task,
      TaskPeriodType.cron,
      this.clock.now(),
    );
    this.taskScheduled(task.queue, taskId);
    return taskId;
  }

  /**
   * Route scheduling signal to the pool that owns the queue.
   *
   * If no worker is registered for the queue, task remains pending until
   * a worker appears.
   *
   * @param queue queue identifier
   * @param taskId created task id if available
   */
  private taskScheduled(queue: string, taskId: Option<number>): void {
    this.queuesPool.get(queue).match({
      some: (poolName) => {
        this.pools.get(poolName).foreach((pool) => {
          pool.taskScheduled(queue);
        });
      },
      none: () => {
        logger.info(
          `No worker registered for a queue '${queue}'. ` +
            `Task (id=${taskId.getOrElseValue(-1)}) will remain in pending state`,
        );
      },
    });
  }
}
