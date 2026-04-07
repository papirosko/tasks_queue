/**
 * Configuration of a worker pool inside {@link TasksPoolsService}.
 *
 * Pools let applications isolate workloads with different concurrency or
 * polling requirements while still sharing the same queue database.
 *
 * See also {@link DEFAULT_POOL} and {@link TasksPoolsService.registerWorker}.
 */
export interface TasksPool {
  /**
   * Unique pool name inside a single {@link TasksPoolsService} instance.
   */
  name: string;
  /**
   * Maximum number of tasks processed concurrently inside this pool.
   */
  concurrency: number;
  /**
   * Polling interval in milliseconds used when no immediate queue notification is available.
   *
   * New tasks usually wake the pipeline immediately via notifications from
   * {@link TasksQueueService.taskScheduled}, but this interval still controls
   * fallback polling and recovery from externally inserted rows.
   */
  loopInterval: number;
}
