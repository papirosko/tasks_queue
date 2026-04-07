import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { TimeUtils } from "./time-utils.js";
import { ManageTasksQueueService } from "./manage-tasks-queue.service.js";
import { Collection, HashMap, Nil, option } from "scats";
import { TasksCount } from "./manage.model.js";
import { MetricsService } from "application-metrics";
import { Clock, SystemClock } from "./clock.js";

const logger = log4js.getLogger("TasksAuxiliaryWorker");

export class TasksAuxiliaryWorker {
  private workerTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private queuesCounts: HashMap<string, Collection<TasksCount>> = HashMap.empty;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    private readonly manageTasksQueueService: ManageTasksQueueService,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  start() {
    this.workerTimer = setInterval(() => {
      void this.runMaintenanceOnce();
    }, TimeUtils.second * 30);
    void this.runMaintenanceOnce();

    this.metricsTimer = setInterval(() => {
      void this.syncMetricsOnce();
    }, TimeUtils.minute * 2);
    void this.syncMetricsOnce();
  }

  async runMaintenanceOnce(): Promise<void> {
    try {
      const failStalledPromise = this.tasksQueueDao
        .failStalled(this.clock.now())
        .then((res) => {
          if (res.nonEmpty) {
            logger.info(`Processed stalled tasks: ${res.mkString(", ")}`);
          }
        })
        .catch((e) => {
          logger.warn("Failed to process stalled tasks", e);
        });
      const resetFailedPromise = this.tasksQueueDao.resetFailed().catch((e) => {
        logger.warn("Failed to reset failed tasks", e);
      });
      const clearFinishedPromise = this.tasksQueueDao
        .clearFinished(undefined, this.clock.now())
        .catch((e) => {
          logger.warn("Failed to clear finished tasks", e);
        });
      await Promise.all([
        failStalledPromise,
        resetFailedPromise,
        clearFinishedPromise,
      ]);
    } catch (e) {
      logger.warn("Failed to process stalled tasks", e);
    }
  }

  async syncMetricsOnce(): Promise<void> {
    try {
      const tasksCounts = await this.manageTasksQueueService.tasksCount();
      this.queuesCounts = tasksCounts.groupBy((c) => c.queueName);
      tasksCounts.foreach((c) => {
        MetricsService.gauge(
          `tasks_queue_${c.queueName}_${c.status}`.replace(
            /[^a-zA-Z0-9_:]/g,
            "_",
          ),
          () => {
            return this.queuesCounts
              .get(c.queueName)
              .getOrElseValue(Nil)
              .find((x) => c.status === x.status)
              .map((c) => c.count)
              .getOrElseValue(0);
          },
        );
      });
    } catch (e) {
      logger.warn("Failed to sync metrics", e);
    }
  }

  stop() {
    option(this.workerTimer).foreach((t) => clearInterval(t));
    option(this.metricsTimer).foreach((t) => clearInterval(t));
  }
}
