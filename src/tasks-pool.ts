export interface TasksPool {
  /**
   * The name of the pool of tasks. Should be unique among the other tasks pools.
   */
  name: string;
  /**
   * The number of tasks allowed to be processed concurrently within this pool.
   */
  concurrency: number;
  /**
   * The interval in milliseconds then the worker will try to fetch new task from the queues.
   * Usually the worker is notified about the new task, once it is created and starts processing it immediately
   * if it is free. In case then the task was added manually into the DB, this interval
   * defines the time, then the worker will fetch new task.
   */
  loopInterval: number;
}
