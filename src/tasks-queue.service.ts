import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { TasksQueueWorker } from "./tasks-queue.worker.js";
import { TasksAuxiliaryWorker } from "./tasks-auxiliary-worker.js";
import { none, Option, some } from "scats";
import {
  SchedulePeriodicTaskDetails,
  ScheduleTaskDetails,
  TaskPeriodType,
} from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { ManageTasksQueueService } from "./manage/manage-tasks-queue.service";

const logger = log4js.getLogger("TasksQueueService");

export interface TasksQueueConfig {
  concurrency: number;
  runAuxiliaryWorker: boolean;
  loopInterval: number;
}

export class TasksQueueService {
  private readonly worker: TasksQueueWorker;
  private readonly auxiliaryWorker: Option<TasksAuxiliaryWorker>;

  constructor(
    private readonly tasksQueueDao: TasksQueueDao,
    manageTasksQueueService: ManageTasksQueueService,
    config: TasksQueueConfig,
  ) {
    this.worker = new TasksQueueWorker(
      this.tasksQueueDao,
      config.concurrency,
      config.loopInterval,
    );
    if (config.runAuxiliaryWorker) {
      this.auxiliaryWorker = some(
        new TasksAuxiliaryWorker(tasksQueueDao, manageTasksQueueService),
      );
    } else {
      this.auxiliaryWorker = none;
    }
  }

  async schedule(task: ScheduleTaskDetails) {
    await this.tasksQueueDao.schedule(task);
    this.taskScheduled(task.queue);
  }

  async scheduleAtFixedRate(task: SchedulePeriodicTaskDetails) {
    await this.tasksQueueDao.schedulePeriodic(task, TaskPeriodType.fixed_rate);
    this.taskScheduled(task.queue);
  }

  async scheduleAtFixedDelay(task: SchedulePeriodicTaskDetails) {
    await this.tasksQueueDao.schedulePeriodic(task, TaskPeriodType.fixed_delay);
    this.taskScheduled(task.queue);
  }

  taskScheduled(queueName: string): void {
    this.worker.tasksScheduled(queueName);
  }

  registerWorker(queueName: string, worker: TasksWorker) {
    this.worker.registerWorker(queueName, worker);
  }

  start() {
    try {
      this.worker.start();
      this.auxiliaryWorker.foreach((w) => w.start());
    } catch (e) {
      logger.warn("Failed to process stalled tasks", e);
    }
  }

  async stop() {
    await this.auxiliaryWorker.mapPromise((w) => w.stop());
    await this.worker.stop();
  }
}
