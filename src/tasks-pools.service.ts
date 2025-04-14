import { TasksPool } from "./tasks-pool.js";
import { Collection, HashMap, mutable, Option } from "scats";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import { TasksQueueService } from "./tasks-queue.service.js";
import { TasksAuxiliaryWorker } from "./tasks-auxiliary-worker.js";
import log4js from "log4js";
import {
  SchedulePeriodicTaskDetails,
  ScheduleTaskDetails,
  TaskPeriodType,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";

export const DEFAULT_POOL = "default";
const logger = log4js.getLogger("TasksPoolsService");

export class TasksPoolsService {
  private readonly pools: HashMap<string, TasksQueueService>;
  private readonly queuesPool = new mutable.HashMap<string, string>();
  private readonly auxiliaryWorker: TasksAuxiliaryWorker;

  constructor(
    private readonly dao: TasksQueueDao,
    pools: TasksPool[] = [
      {
        name: DEFAULT_POOL,
        concurrency: 1,
        loopInterval: 60000,
      },
    ],
  ) {
    const poolsCollection = Collection.from(pools);
    const poolNames = poolsCollection.map((p) => p.name).toSet;
    if (poolsCollection.size !== poolNames.size) {
      throw new Error("Duplicate pool names detected");
    }
    this.pools = poolsCollection.toMap((p) => [
      p.name,
      new TasksQueueService(dao, {
        concurrency: p.concurrency,
        runAuxiliaryWorker: false,
        loopInterval: p.loopInterval,
      }),
    ]);
    this.auxiliaryWorker = new TasksAuxiliaryWorker(dao);
  }

  start() {
    logger.info(`Starting TasksPoolsService with ${this.pools.size} pools`);
    this.auxiliaryWorker.start();
    this.pools.values.foreach((p) => p.start());
  }

  async stop(timeoutMs = 30000) {
    logger.info("Stopping TasksPoolsService");
    try {
      await Promise.race([
        Promise.all([
          this.auxiliaryWorker.stop(),
          this.pools.values.mapPromise((p) => p.stop()),
        ]),
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

  async schedule(task: ScheduleTaskDetails) {
    const taskId = await this.dao.schedule(task);
    this.taskScheduled(task.queue, taskId);
  }

  async scheduleAtFixedRate(task: SchedulePeriodicTaskDetails) {
    const taskId = await this.dao.schedulePeriodic(
      task,
      TaskPeriodType.fixed_rate,
    );
    this.taskScheduled(task.queue, taskId);
  }

  async scheduleAtFixedDelay(task: SchedulePeriodicTaskDetails) {
    const taskId = await this.dao.schedulePeriodic(
      task,
      TaskPeriodType.fixed_delay,
    );
    this.taskScheduled(task.queue, taskId);
  }

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
