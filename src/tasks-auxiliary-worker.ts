import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { TaskStatus } from "./tasks-model.js";
import { TimeUtils } from "./time-utils.js";

const logger = log4js.getLogger("TasksAuxiliaryWorker");

export class TasksAuxiliaryWorker {
  private workerTimer: NodeJS.Timeout | null = null;

  constructor(private readonly tasksQueueDao: TasksQueueDao) {}

  start() {
    try {
      const run = () => {
        this.runAuxiliaryJobs();
      };
      this.workerTimer = setInterval(() => run(), TimeUtils.second * 30);
      run();
    } catch (e) {
      logger.warn("Failed to process stalled tasks", e);
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

  async stop() {
    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
    }
  }

  pendingCount(queue: string): Promise<number> {
    return this.tasksQueueDao.statusCount(queue, TaskStatus.pending);
  }

  inProgressCount(queue: string): Promise<number> {
    return this.tasksQueueDao.statusCount(queue, TaskStatus.in_progress);
  }
}
