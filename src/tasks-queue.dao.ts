import { Collection, HashSet, none, option, Option } from "scats";
import pg, { PoolClient } from "pg";
import {
  BackoffType,
  ScheduledTask,
  TaskPeriodType,
  TaskStatus,
} from "./tasks-model.js";
import type {
  ScheduleTaskDetails,
  SchedulePeriodicTaskDetails,
} from "./tasks-model.js";
import { Metric } from "application-metrics";
import { TimeUtils } from "./time-utils";

export class TasksQueueDao {
  constructor(private readonly pool: pg.Pool) {}

  private async withClient<T>(
    cb: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let res: T;
    try {
      res = await cb(client);
    } finally {
      client.release();
    }
    return res;
  }

  /**
   * Add new task to a queue, that will be executed once upon successful competition.
   * @param task parameters of the new task
   * @return the id of the created task
   */
  @Metric()
  async schedule(task: ScheduleTaskDetails): Promise<Option<number>> {
    const now = new Date();
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `insert into tasks_queue (queue, created, status, priority, payload, timeout, max_attempts, start_after, backoff,
                                          backoff_type)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 returning id`,
        [
          task.queue,
          now,
          TaskStatus.pending,
          option(task.priority).getOrElseValue(0),
          task.payload,
          option(task.timeout).getOrElseValue(TimeUtils.hour),
          option(task.retries).getOrElseValue(1),
          option(task.startAfter).orNull,
          option(task.backoff).getOrElseValue(TimeUtils.minute),
          option(task.backoffType).getOrElseValue(BackoffType.linear),
        ],
      );
      return Collection.from(res.rows).headOption.map((r) => r.id as number);
    });
  }

  /**
   * Add new task to a queue, that will be executed periodically with the fixed rate.
   * @param task parameters of the new task
   * @param periodType how to repeat the task, based on fixed-rate or fixed-delay.
   * @return the id of the created task or none if task was not scheduled (e.g. already exists)
   */
  @Metric()
  async schedulePeriodic(
    task: SchedulePeriodicTaskDetails,
    periodType: TaskPeriodType,
  ): Promise<Option<number>> {
    const now = new Date();
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `insert into tasks_queue (queue, created, status, priority, payload, timeout, max_attempts, start_after, name,
                                          repeat_interval, repeat_type, backoff, backoff_type)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 on conflict (name) do nothing
                 returning id`,
        [
          task.queue,
          now,
          TaskStatus.pending,
          option(task.priority).getOrElseValue(0),
          task.payload,
          option(task.timeout).getOrElseValue(TimeUtils.hour),
          option(task.retries).getOrElseValue(1),
          option(task.startAfter).getOrElseValue(now),
          task.name,
          task.period,
          periodType,
          option(task.backoff).getOrElseValue(TimeUtils.minute),
          option(task.backoffType).getOrElseValue(BackoffType.linear),
        ],
      );
      return Collection.from(res.rows).headOption.map((r) => r.id as number);
    });
  }

  /**
   * Fetches a new task to be processed from one of the specified queues.
   *
   * Conditions for fetching:
   * - Task must have status = 'pending'
   * - Task must belong to one of the specified queues
   * - Task must have attempt count < max_attempts (default is 1 if unset)
   * - Task must have start_after <= now() or be null
   *
   * Among the matching tasks, the one with the highest priority will be selected.
   * If multiple tasks share the same priority, the one with the smallest id will be chosen.
   *
   * When fetched, the task's status will be set to 'in_progress', 'started' timestamp will be updated,
   * and the attempt count will be incremented.
   *
   * @param queueNames the queues where the tasks are searched.
   * @return the brief details of the fetched task, if any
   */
  @Metric()
  async nextPending(
    queueNames: HashSet<string>,
  ): Promise<Option<ScheduledTask>> {
    if (queueNames.isEmpty) {
      return none;
    }

    const now = new Date();
    const placeholders = queueNames.zipWithIndex
      .map(([_, idx]) => `$${idx + 4}`)
      .mkString(",");
    const paramsStatic: any[] = [
      TaskStatus.in_progress,
      now,
      TaskStatus.pending,
    ];
    const params = paramsStatic.concat(queueNames.toArray);

    return await this.withClient(async (cl) => {
      const query = `
                WITH selected AS (SELECT id, payload, queue
                                  FROM tasks_queue
                                  WHERE status = $3
                                    AND queue IN (${placeholders})
                                    AND max_attempts > attempt
                                    AND (start_after IS NULL or start_after <= $2)
                                  ORDER BY priority DESC, id ASC
                                      FOR UPDATE SKIP LOCKED
                                  LIMIT 1)
                UPDATE tasks_queue
                SET status   = $1,
                    started  = $2,
                    finished = null,
                    attempt  = attempt + 1
                FROM selected
                WHERE tasks_queue.id = selected.id
                RETURNING tasks_queue.id, tasks_queue.payload, tasks_queue.queue, tasks_queue.repeat_type;
            `;

      const res = await cl.query(query, params);
      return Collection.from(res.rows).headOption.map((r) => {
        return {
          id: r["id"],
          payload: r["payload"],
          queue: r["queue"],
          repeatType: option(r["repeat_type"]).orUndefined,
        } as ScheduledTask;
      });
    });
  }

  /**
   * Returns the earliest upcoming `start_after` timestamp from the task queue.
   *
   * This can be used to calculate how long to sleep before polling again
   * without increasing the overall polling frequency.
   *
   * Only considers tasks with status `'pending'` or `'error'` and where `start_after > now`.
   *
   * Returns `none` if no such task exists.
   *
   * @returns The earliest future `start_after` timestamp, if any.
   */
  @Metric()
  async peekNextStartAfter(queueNames: HashSet<string>): Promise<Option<Date>> {
    if (queueNames.isEmpty) {
      return none;
    }

    const now = new Date();
    const placeholders = queueNames.zipWithIndex
      .map(([_, idx]) => `$${idx + 4}`)
      .mkString(",");
    return this.withClient(async (cl) => {
      const paramsStatic: any[] = [TaskStatus.pending, TaskStatus.error, now];
      const params = paramsStatic.concat(queueNames.toArray);
      const res = await cl.query(
        `SELECT MIN(start_after) AS min_start
                 FROM tasks_queue
                 WHERE status IN ($1, $2)
                   AND queue IN (${placeholders})
                   AND start_after > $3`,
        params,
      );
      return Collection.from(res.rows)
        .headOption.flatMap((r) => option(r["min_start"]))
        .map((ts) => new Date(ts));
    });
  }

  /**
   * Mark task as finished. Task status will be set to 'finished'. The 'error' field will be cleared.
   * The 'finished' field will be set to current timestamp.
   * Task should have status='in_progress' to be updated.
   * @param taskId the id of the task
   */
  @Metric()
  async finish(taskId: number): Promise<void> {
    const now = new Date();
    await this.withClient(async (cl) => {
      await cl.query(
        `update tasks_queue
                 set status=$1,
                     finished=$2,
                     error=null
                 where id = $3
                   and status = $4`,
        [TaskStatus.finished, now, taskId, TaskStatus.in_progress],
      );
    });
  }

  /**
   * Reschedule a periodic task by setting its status back to 'pending' and updating the 'start_after' field
   * based on the task's repeat_interval and repeat_type.
   *
   * Task must have status='in_progress', repeat_interval != null and a valid repeat_type ('fixedRate' or 'fixedDelay').
   *
   * @param taskId the id of the task
   */
  @Metric()
  async rescheduleIfPeriodic(taskId: number): Promise<void> {
    const now = new Date();
    await this.withClient(async (cl) => {
      await cl.query(
        `
                    update tasks_queue
                    set status      = $1,
                        start_after = case
                                          when repeat_type = '${TaskPeriodType.fixed_rate}' then
                                              coalesce(start_after, started) + (repeat_interval || ' millisecond')::interval
                                          when repeat_type = '${TaskPeriodType.fixed_delay}'
                                              then cast($2 as timestamp) + (repeat_interval || ' millisecond')::interval
                                          else null
                            end,
                        finished    = $2,
                        error       = null,
                        attempt     = 0
                    where id = $3
                      and status = $4
                      and repeat_interval is not null
                      and repeat_type in ('${TaskPeriodType.fixed_rate}', '${TaskPeriodType.fixed_delay}')
                `,
        [TaskStatus.pending, now, taskId, TaskStatus.in_progress],
      );
    });
  }

  /**
   * Marks the task as failed.
   *
   * If the task has remaining attempts (i.e., attempt + 1 < max_attempts), it is rescheduled immediately:
   * - Its status is set to 'pending'.
   * - The 'start_after' field is set to a future time calculated using the 'backoff' and 'backoff_type' fields.
   *     - For 'constant' backoff: delay = backoff
   *     - For 'linear' backoff: delay = backoff * attempt
   *     - For 'exponential' backoff: delay = backoff * 2^attempt
   * - The 'finished' timestamp is updated to the current time.
   * - The 'error' field is updated with the provided message.
   *
   * If no attempts remain, the task is marked as permanently failed:
   * - Its status is set to 'error'.
   * - The 'start_after' field is cleared (set to NULL).
   *
   * This update will only take place if the task is currently in 'in_progress' status.
   *
   * @param taskId The ID of the task.
   * @param error The error message to store in the task's 'error' field.
   * @returns The new status of the task after the update (`'pending'` or `'error'`).
   */
  @Metric()
  async fail(taskId: number, error: string): Promise<TaskStatus> {
    const now = new Date();

    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `
                    UPDATE tasks_queue
                    SET finished    = $1,
                        error       = $2,
                        status      = CASE
                                          WHEN attempt < max_attempts THEN $3 -- pending
                                          ELSE $4 -- error
                            END,
                        start_after = CASE
                                          WHEN attempt < max_attempts THEN
                                              $1::timestamp + (
                                                                  CASE backoff_type
                                                                      WHEN 'constant' THEN backoff
                                                                      WHEN 'linear' THEN (backoff * attempt)
                                                                      WHEN 'exponential'
                                                                          THEN (backoff * POWER(2, attempt))
                                                                      ELSE backoff
                                                                      END
                                                                  ) * interval '1 millisecond'
                                          ELSE NULL
                            END
                    WHERE id = $5
                      AND status = $6
                    returning status
                `,
        [
          now, // $1
          error, // $2
          TaskStatus.pending, // $3
          TaskStatus.error, // $4
          taskId, // $5
          TaskStatus.in_progress, // $6
        ],
      );
      return Collection.from(res.rows)
        .headOption.map((r) => TaskStatus[r.status as keyof typeof TaskStatus])
        .getOrElseValue(TaskStatus.error);
    });
  }

  /**
   * Marks all stalled tasks as failed.
   * The status field will be set to 'error'. A message 'Timeout' will be written into the 'error' field.
   * The finished field will be set to current timestamp.
   *
   * To be updated The task should have
   *  - status='in_progress'
   *  - defined timeout and started + timeout should be less than current timestamp
   * @return ids of the updated tasks.
   */
  @Metric()
  async failStalled(): Promise<Collection<number>> {
    const now = new Date();
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `update tasks_queue
                 set status=$1,
                     finished=$2,
                     error=$3
                 where status = $4
                   and timeout is not null
                   and started + timeout * interval '1  ms' < $5
                 returning id`,
        [TaskStatus.error, now, "Timeout", TaskStatus.in_progress, now],
      );
      return Collection.from(res.rows).map((r) => r.id as number);
    });
  }

  /**
   * Requeues all failed tasks.
   * The task should have status='error', the number of attempts for a task should be less
   * than a number of maximum allowed attempts (which is set in 'retries' field, defaults to 1).
   *
   * All suitable tasks will have the 'status' field set to 'pending', the 'finished' field cleared.
   */
  @Metric()
  async resetFailed(): Promise<void> {
    await this.withClient(async (cl) => {
      await cl.query(
        `update tasks_queue
                 set status=$1,
                     finished=null
                 where status = $2
                   and timeout is not null
                   and max_attempts > COALESCE(attempt, 0)`,
        [TaskStatus.pending, TaskStatus.error],
      );
    });
  }

  /**
   * Removes all finished tasks.
   * The task should have status='finished' and current timestamp should be greater then
   * the time, when the task was finished plus the timeout.
   *
   * @param timeout the duration between the time, when the task was finished and current timestamp
   */
  @Metric()
  async clearFinished(timeout: number = TimeUtils.day): Promise<void> {
    const expired = new Date(Date.now() - timeout);
    await this.withClient(async (cl) => {
      await cl.query(
        `delete
                 from tasks_queue
                 where status = $1
                   and finished < $2`,
        [TaskStatus.finished, expired],
      );
    });
  }

  /**
   * Calculates the number of the tasks with specified status in a specified queue.
   * @param queue the name of the queue.
   * @param status the status of the task to be counted
   */
  @Metric()
  async statusCount(queue: string, status: TaskStatus) {
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `select count(id) as cnt
                 from tasks_queue
                 where queue = $1
                   and status = $2`,
        [queue, status],
      );
      return Collection.from(res.rows)
        .headOption.map((r) => r["cnt"] as number)
        .getOrElseValue(0);
    });
  }
}
