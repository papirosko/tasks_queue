import { option, Option } from "scats";
import log4js from "log4js";
import { ScheduledTask } from "./tasks-model.js";
import { TimeUtils } from "./time-utils";

const defaultLoopInterval = TimeUtils.minute;

enum PipelineNextOperationType {
  PollNext,
  Sleep,
}

type PipelineNextOperation =
  | { type: PipelineNextOperationType.PollNext }
  | { type: PipelineNextOperationType.Sleep; delayMs: number };

const PipelineNextOperationFactory = {
  pollNext: {
    type: PipelineNextOperationType.PollNext,
  } as PipelineNextOperation,
  sleep: (delayMs: number = defaultLoopInterval): PipelineNextOperation => ({
    type: PipelineNextOperationType.Sleep,
    delayMs,
  }),
};

const logger = log4js.getLogger("TasksPipeline");

const noop: () => void = () => {
  // nothing to do
};

/**
 * Class responsible for polling and processing tasks from a queue.
 * Tasks are processed concurrently, with a limit on the maximum number of concurrently running tasks.
 */
export class TasksPipeline {
  private tasksInProcess = 0;
  private loopRunning = false;
  private nextLoopTime = 0;
  private periodicTaskFetcher: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private tasksCountListener: (n: number) => void = noop;
  private readonly loopTimer: () => Promise<void>;

  /**
   * Creates an instance of TasksPipeline.
   *
   * @param maxConcurrentTasks Maximum number of tasks to be processed concurrently.
   * @param pollNextTask A function to fetch the next task to process.
   * @param peekNextStartAfter a function to fetch next start_after value to reduce sleep time
   * @param processTask A function that processes a fetched task.
   * @param loopInterval Interval in milliseconds between polling attempts if no tasks are found.
   */
  constructor(
    private readonly maxConcurrentTasks: number,
    private readonly pollNextTask: () => Promise<Option<ScheduledTask>>,
    private readonly peekNextStartAfter: () => Promise<Option<Date>>,
    private readonly processTask: (t: ScheduledTask) => Promise<void>,
    private readonly loopInterval = defaultLoopInterval,
  ) {
    this.loopTimer = async () => {
      this.periodicTaskFetcher = null;
      let sleepInterval = this.loopInterval;
      try {
        sleepInterval = await this.loop();
      } finally {
        if (!this.periodicTaskFetcher) {
          this.nextLoopTime = Date.now() + sleepInterval;
          this.periodicTaskFetcher = setTimeout(
            () => this.loopTimer(),
            Math.min(this.loopInterval, sleepInterval),
          );
        }
      }
    };
  }

  /**
   * Starts the periodic task polling loop.
   */
  start() {
    this.stopRequested = false;
    option(this.periodicTaskFetcher).foreach((t) => clearTimeout(t));

    this.nextLoopTime = Date.now() + 1;
    this.periodicTaskFetcher = setTimeout(() => this.loopTimer(), 1);
  }

  /**
   * Stops the task polling loop and waits for all running tasks to complete.
   */
  async stop() {
    this.stopRequested = true;
    option(this.periodicTaskFetcher).foreach((t) => clearTimeout(t));
    if (this.tasksInProcess > 0) {
      await new Promise<void>((resolve) => {
        this.tasksCountListener = (n) => {
          if (n <= 0) {
            this.tasksCountListener = noop;
            resolve();
          }
        };
      });
    }
  }

  /**
   * Triggers the polling loop immediately if it is not already running.
   */
  triggerLoop() {
    if (!this.loopRunning && !this.stopRequested) {
      setTimeout(() => this.loop(), 1);
    }
  }

  /**
   * Internal method that performs a single polling loop.
   * It attempts to fetch and start processing tasks until the maximum number of concurrent tasks is reached.
   */
  private async loop() {
    if (this.loopRunning || this.stopRequested) {
      return this.loopInterval;
    }
    this.loopRunning = true;
    let sleepInterval = this.loopInterval;
    try {
      let nextOp = PipelineNextOperationFactory.pollNext;
      while (nextOp.type !== PipelineNextOperationType.Sleep) {
        if (
          this.tasksInProcess < this.maxConcurrentTasks &&
          !this.stopRequested
        ) {
          nextOp = await this.fetchNextTask();
        } else {
          nextOp = PipelineNextOperationFactory.sleep(this.loopInterval);
        }
      }
      sleepInterval = Math.min(nextOp.delayMs, this.loopInterval);
    } finally {
      this.loopRunning = false;
    }

    const nextTriggerTime = Date.now() + sleepInterval;
    if (this.periodicTaskFetcher && this.nextLoopTime > nextTriggerTime) {
      logger.trace(
        `Resetting loop timer to closer time: from ${new Date(this.nextLoopTime)} to new ${new Date(nextTriggerTime)}`,
      );
      clearTimeout(this.periodicTaskFetcher);
      this.nextLoopTime = nextTriggerTime;
      this.periodicTaskFetcher = setTimeout(
        () => this.loopTimer(),
        Math.min(this.loopInterval, sleepInterval),
      );
    }

    return sleepInterval;
  }

  /**
   * Fetches the next pending task using the poll function and schedules it for processing.
   *
   * @returns The next operation to perform in the loop.
   */
  private async fetchNextTask(): Promise<PipelineNextOperation> {
    const task = await this.pollNextTask();
    return task.match({
      some: async (t) => {
        this.tasksInProcess++;
        setImmediate(() => this.processTaskInLoop(t));
        return this.tasksInProcess < this.maxConcurrentTasks
          ? PipelineNextOperationFactory.pollNext
          : PipelineNextOperationFactory.sleep(this.loopInterval);
      },
      none: async () => {
        const nextTimeOpt = await this.peekNextStartAfter();
        const delayMs = nextTimeOpt
          .map((startAfter) => {
            const delay = startAfter.getTime() - Date.now();
            return Math.max(0, delay);
          })
          .getOrElseValue(this.loopInterval); // fallback if no future task
        return PipelineNextOperationFactory.sleep(delayMs);
      },
    });
  }

  /**
   * Starts processing a task and handles any errors that might occur.
   * Once processing is finished, triggers the next polling loop.
   *
   * @param t The task to be processed.
   */
  private async processTaskInLoop(t: ScheduledTask) {
    try {
      logger.debug(
        `Starting task (id=${t.id}) in queue ${t.queue} (active ${this.tasksInProcess} of ${this.maxConcurrentTasks})`,
      );
      await this.processTask(t);
    } catch (error) {
      logger.warn(`Failed to process task ${t.id} in queue ${t.queue} `, error);
    } finally {
      this.taskIsDone();
      logger.debug(
        `Finished working with task ${t.id} in queue ${t.queue} (active ${this.tasksInProcess} of ${this.maxConcurrentTasks})`,
      );
      setImmediate(() => this.loop());
    }
  }

  /**
   * Marks a task as completed, decreases the number of active tasks and notifies the listener if needed.
   */
  private taskIsDone() {
    this.tasksInProcess--;
    this.tasksCountListener(this.tasksInProcess);
  }
}
