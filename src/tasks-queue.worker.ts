import { mutable, option, Try } from "scats";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import log4js from "log4js";
import { MetricsService } from "application-metrics";
import { TasksPipeline } from "./tasks-pipeline.js";
import { ScheduledTask } from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";
import { TimeUtils } from "./time-utils.js";

const logger = log4js.getLogger("TasksQueueWorker");

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

  async stop(): Promise<void> {
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

  private async processNextTask(task: ScheduledTask): Promise<void> {
    MetricsService.counter("tasks_queue_started").inc();
    await this.workers.get(task.queue).match({
      some: async (worker) => {
        try {
          Try(() => worker.starting(task.id, task.payload)).tapFailure((e) =>
            logger.warn(
              `Failed to invoke 'starting' callback for task (id=${task.id}) in queue=${task.queue}`,
              e,
            ),
          );
          await worker.process(task.payload);
          if (option(task.repeatType).isEmpty) {
            await this.tasksQueueDao.finish(task.id);
          } else {
            await this.tasksQueueDao.rescheduleIfPeriodic(task.id);
          }
          MetricsService.counter("tasks_queue_processed").inc();
          Try(() => worker.completed(task.id, task.payload)).tapFailure((e) =>
            logger.warn(
              `Failed to invoke 'completed' callback for task (id=${task.id}) in queue=${task.queue}`,
              e,
            ),
          );
        } catch (e) {
          const finalStatus = await this.tasksQueueDao.fail(
            task.id,
            (e as any)["message"] || e,
          );
          Try(() =>
            worker.failed(task.id, task.payload, finalStatus, e),
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
