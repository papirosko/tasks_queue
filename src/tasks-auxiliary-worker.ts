import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { TimeUtils } from "./time-utils.js";
import { ManageTasksQueueService } from "./manage/manage-tasks-queue.service";
import { Collection, HashMap, Nil, option } from "scats";
import { TasksCount } from "./manage/manage.model";
import { MetricsService } from "application-metrics";

const logger = log4js.getLogger("TasksAuxiliaryWorker");

export class TasksAuxiliaryWorker {
  private workerTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private queuesCounts: HashMap<string, Collection<TasksCount>> = HashMap.empty;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    private readonly manageTasksQueueService: ManageTasksQueueService,
  ) {}

  start() {
    const runWorker = () => {
      this.runAuxiliaryJobs();
    };
    this.workerTimer = setInterval(() => {
      try {
        runWorker();
      } catch (e) {
        logger.warn("Failed to process stalled tasks", e);
      }
    }, TimeUtils.second * 30);
    try {
      runWorker();
    } catch (e) {
      logger.warn("Failed to process stalled tasks", e);
    }

    const runMetrics = () => {
      this.fetchMetrics();
    };
    this.metricsTimer = setInterval(() => {
      try {
        runMetrics();
      } catch (e) {
        logger.warn("Failed to sync metrics", e);
      }
    }, TimeUtils.minute * 2);
    try {
      runMetrics();
    } catch (e) {
      logger.warn("Failed to sync metrics", e);
    }
  }

  private runAuxiliaryJobs() {
    try {
      this.tasksQueueDao
        .failStalled()
        .then((res) => {
          if (res.nonEmpty) {
            logger.info(`Marked stalled as failed: ${res.mkString(", ")}`);
          }
        })
        .catch((e) => {
          logger.warn("Failed to process stalled tasks", e);
        });
      this.tasksQueueDao.resetFailed().catch((e) => {
        logger.warn("Failed to reset failed tasks", e);
      });
      this.tasksQueueDao.clearFinished().catch((e) => {
        logger.warn("Failed to clear finished tasks", e);
      });
    } catch (e) {
      logger.warn("Failed to process stalled tasks", e);
    }
  }

  private fetchMetrics() {
    this.manageTasksQueueService
      .tasksCount()
      .then((tasksCounts) => {
        this.queuesCounts = tasksCounts.groupBy((c) => c.queueName);
        tasksCounts.foreach((c) => {
          MetricsService.gauge(
            `tasks_queue_${c.queueName}_${c.status}`.replace(/-.,:\/\\/g, "_"),
            () => {
              return this.queuesCounts
                .get(c.queueName)
                .getOrElseValue(Nil)
                .find((c) => c.status === c.status)
                .map((c) => c.count)
                .getOrElseValue(0);
            },
          );
        });
      })
      .catch((e) => {
        logger.warn("Failed to sync metrics", e);
      });
  }

  async stop() {
    option(this.workerTimer).foreach((t) => clearTimeout(t));
    option(this.metricsTimer).foreach((t) => clearTimeout(t));
  }
}
