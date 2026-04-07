import { Collection, HashSet, none, option, Option, some } from "scats";
import pg, { PoolClient } from "pg";
import type {
  ScheduleCronTaskDetails,
  SchedulePeriodicTaskDetails,
  ScheduleTaskDetails,
  SpawnChildTaskDetails,
} from "./tasks-model.js";
import {
  BackoffType,
  MissedRunStrategy,
  ScheduledTask,
  TASK_HEARTBEAT_THROTTLE_MS,
  TaskStateSnapshot,
  TaskPeriodType,
  TaskStatus,
} from "./tasks-model.js";
import { Metric } from "application-metrics";
import { TimeUtils } from "./time-utils.js";
import { CronExpressionUtils } from "./cron-expression-utils.js";
import {
  PeriodicScheduleConfig,
  PeriodicScheduleUtils,
} from "./periodic-schedule-utils.js";
import { MultiStepPayload } from "./multi-step-payload.js";
import { ActiveChildState } from "./active-child-state.js";

export class TasksQueueDao {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert a one-time task using an existing database client.
   *
   * This helper is shared by regular scheduling and parent-child orchestration flows,
   * so child tasks can be created atomically together with parent status updates.
   *
   * @param cl active database client
   * @param task one-time task parameters
   * @param parentId optional parent task id
   * @returns created task id if insert succeeded
   */
  private async insertOneTimeTask(
    cl: PoolClient,
    task: ScheduleTaskDetails,
    parentId?: number,
    now: Date = new Date(),
  ): Promise<Option<number>> {
    const res = await cl.query(
      `insert into tasks_queue (parent_id, queue, created, status, priority, payload, timeout, max_attempts,
                                        start_after, initial_start, backoff, backoff_type)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               returning id`,
      [
        option(parentId).orNull,
        task.queue,
        now,
        TaskStatus.pending,
        option(task.priority).getOrElseValue(0),
        option(task.payload).orNull,
        option(task.timeout).getOrElseValue(TimeUtils.hour),
        option(task.retries).getOrElseValue(1),
        option(task.startAfter).orNull,
        option(task.startAfter).getOrElseValue(now),
        option(task.backoff).getOrElseValue(TimeUtils.minute),
        option(task.backoffType).getOrElseValue(BackoffType.linear),
      ],
    );
    return Collection.from(res.rows).headOption.map((r) => r.id as number);
  }

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
  async schedule(
    task: ScheduleTaskDetails,
    now: Date = new Date(),
  ): Promise<Option<number>> {
    return await this.withClient(async (cl) => {
      return this.insertOneTimeTask(cl, task, undefined, now);
    });
  }

  /**
   * Atomically transition a parent task into `blocked` state and create its child task.
   *
   * This method is intended for one-time parent tasks only. Parent blocking and child creation
   * happen in the same transaction, so the system never observes a blocked parent without a child
   * or a child without its parent being blocked.
   *
   * @param parentTaskId parent task currently being processed
   * @param childTask one-time child task details
   * @returns created child task id
   */
  @Metric()
  async blockParentAndScheduleChild(
    parentTaskId: number,
    childTask: SpawnChildTaskDetails,
    parentPayload: object,
    expectedStarted: Date,
    now: Date = new Date(),
  ): Promise<Option<number>> {
    return await this.withClient(async (cl) => {
      await cl.query("BEGIN");
      try {
        const parentRes = await cl.query(
          `update tasks_queue
               set status = $1,
                   attempt = greatest(attempt - 1, 0),
                   started = null,
                   last_heartbeat = null,
                   finished = null,
                   error = null
             where id = $2
               and status = $3
               and started = $4
               and repeat_type is null
             returning id`,
          [
            TaskStatus.blocked,
            parentTaskId,
            TaskStatus.in_progress,
            expectedStarted,
          ],
        );
        if ((parentRes.rowCount ?? 0) !== 1) {
          await cl.query("ROLLBACK");
          return none;
        }

        const childTaskId = await this.insertOneTimeTask(
          cl,
          childTask,
          parentTaskId,
          now,
        );
        await childTaskId.mapPromise(async (id) => {
          await cl.query(
            `update tasks_queue
                 set payload = $1
               where id = $2
                 and status = $3`,
            [
              MultiStepPayload.fromJson(parentPayload).copy({
                activeChild: option(
                  new ActiveChildState(id, childTask.allowFailure === true),
                ),
              }).toJson,
              parentTaskId,
              TaskStatus.blocked,
            ],
          );
          return id;
        });
        await cl.query("COMMIT");
        return childTaskId;
      } catch (e) {
        await cl.query("ROLLBACK");
        throw e;
      }
    });
  }

  /**
   * Add a new periodic task to the queue.
   *
   * Supported periodic modes:
   * - `fixed_rate`: uses `period` in milliseconds.
   * - `fixed_delay`: uses `period` in milliseconds.
   * - `cron`: uses `cronExpression`.
   *
   * Cron expressions support both common formats:
   * - 5-field format: `minute hour day-of-month month day-of-week`
   * - 6-field format: `second minute hour day-of-month month day-of-week`
   *
   * @param task parameters of the periodic task
   * @param periodType repeat type that defines how next execution is calculated
   * @return the id of the created task or none if task was not scheduled (e.g. already exists)
   */
  @Metric()
  async schedulePeriodic(
    task: SchedulePeriodicTaskDetails | ScheduleCronTaskDetails,
    periodType: TaskPeriodType,
    now: Date = new Date(),
  ): Promise<Option<number>> {
    // Build a consistent storage representation before writing to the database.
    // Exactly one of repeat_interval or cron_expression must be set.
    const repeatInterval = PeriodicScheduleUtils.resolveRepeatInterval(
      task,
      periodType,
    );
    const cronExpression = PeriodicScheduleUtils.resolveCronExpression(
      task,
      periodType,
    );

    // Validate cron early so invalid schedules never enter persistent storage.
    option(cronExpression).foreach((expr) =>
      CronExpressionUtils.validate(expr),
    );

    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `insert into tasks_queue (queue, created, status, priority, payload, timeout, max_attempts,
                                          start_after, initial_start, name,
                                          repeat_interval, cron_expression, repeat_type, backoff, backoff_type, missed_runs_strategy)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15)
                 on conflict (name) do nothing
                 returning id`,
        [
          task.queue,
          now,
          TaskStatus.pending,
          option(task.priority).getOrElseValue(0),
          option(task.payload).orNull,
          option(task.timeout).getOrElseValue(TimeUtils.hour),
          option(task.retries).getOrElseValue(1),
          option(task.startAfter).getOrElseValue(now),
          task.name,
          repeatInterval,
          cronExpression,
          periodType,
          option(task.backoff).getOrElseValue(TimeUtils.minute),
          option(task.backoffType).getOrElseValue(BackoffType.linear),
          option(task.missedRunStrategy).getOrElseValue(
            MissedRunStrategy.skip_missed,
          ),
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
    now: Date = new Date(),
  ): Promise<Option<ScheduledTask>> {
    if (queueNames.isEmpty) {
      return none;
    }
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
                WITH selected AS (SELECT id, parent_id, payload, queue
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
                    last_heartbeat = null,
                    result = null,
                    finished = null,
                    attempt  = attempt + 1
                FROM selected
                WHERE tasks_queue.id = selected.id
                RETURNING 
                    tasks_queue.id,
                    tasks_queue.started,
                    tasks_queue.parent_id,
                    tasks_queue.payload, 
                    tasks_queue.queue,
                    tasks_queue.repeat_type,
                    tasks_queue.timeout,
                    tasks_queue.attempt,
                    tasks_queue.max_attempts
            `;

      const res = await cl.query(query, params);
      return Collection.from(res.rows).headOption.map((r) => {
        return {
          id: r["id"],
          started: new Date(r["started"]),
          parentId: option(r["parent_id"]).map(Number).orUndefined,
          payload: option(r["payload"]).orUndefined,
          queue: r["queue"],
          repeatType: option(r["repeat_type"]).orUndefined,
          timeout: Number(r["timeout"]),
          currentAttempt: r["attempt"],
          maxAttempts: r["max_attempts"],
        } as ScheduledTask;
      });
    });
  }

  /**
   * Load a minimal persistent snapshot of a task by id.
   *
   * The returned shape is intentionally compact and suitable for orchestration logic
   * that needs to inspect child task status, runtime payload, and final result without
   * depending on management APIs.
   *
   * @param taskId task id to load
   * @returns task snapshot if the row exists
   */
  @Metric()
  async findTaskState(taskId: number): Promise<Option<TaskStateSnapshot>> {
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `select id, parent_id, status, payload, result, error
           from tasks_queue
          where id = $1`,
        [taskId],
      );
      return Collection.from(res.rows).headOption.map((r) => ({
        id: Number(r["id"]),
        parentId: option(r["parent_id"]).map(Number).orUndefined,
        status: TaskStatus[r["status"] as keyof typeof TaskStatus],
        payload: option(r["payload"]).orUndefined,
        result: option(r["result"]),
        error: option(r["error"]).map(String).orUndefined,
      }));
    });
  }

  @Metric()
  async ping(
    taskId: number,
    expectedStarted: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    const cutoff = new Date(now.getTime() - TASK_HEARTBEAT_THROTTLE_MS);
    return await this.withClient(async (cl) => {
      const state = await cl.query(
        `select status, started, last_heartbeat
           from tasks_queue
          where id = $1`,
        [taskId],
      );
      const row = Collection.from(state.rows).headOption;
      if (row.isEmpty) {
        return false;
      }

      const current = row.get;
      if (
        current["status"] !== TaskStatus.in_progress ||
        new Date(current["started"]).getTime() !== expectedStarted.getTime()
      ) {
        return false;
      }

      const lastHeartbeat = option(current["last_heartbeat"]).map(
        (value) => new Date(value),
      );
      if (
        lastHeartbeat
          .map((value) => value.getTime() >= cutoff.getTime())
          .getOrElseValue(false)
      ) {
        return true;
      }

      const res = await cl.query(
        `update tasks_queue
            set last_heartbeat = $1
          where id = $2
            and status = $3
            and started = $4`,
        [now, taskId, TaskStatus.in_progress, expectedStarted],
      );
      return (res.rowCount ?? 0) === 1;
    });
  }

  /**
   * Applies timeout failure semantics to a single task if its current attempt is already stalled.
   *
   * Returns `none` when the task is still healthy and remains `in_progress`.
   * Returns the current final status when the task has already timed out or is no longer `in_progress`
   * because timeout handling was already applied by another code path.
   */
  @Metric()
  async failIfStalled(
    taskId: number,
    expectedStarted: Date,
    now: Date = new Date(),
  ): Promise<Option<TaskStatus>> {
    return await this.withClient(async (cl) => {
      await cl.query("BEGIN");
      try {
        const taskRes = await cl.query(
          `select id,
                  parent_id,
                  status,
                  started,
                  last_heartbeat,
                  timeout,
                  attempt,
                  max_attempts,
                  backoff,
                  backoff_type
             from tasks_queue
            where id = $1
            for update`,
          [taskId],
        );
        const taskRow = Collection.from(taskRes.rows).headOption;
        if (taskRow.isEmpty) {
          await cl.query("COMMIT");
          return none;
        }

        const row = taskRow.get;
        const currentStatus =
          TaskStatus[row["status"] as keyof typeof TaskStatus];
        if (currentStatus !== TaskStatus.in_progress) {
          await cl.query("COMMIT");
          return some(currentStatus as TaskStatus);
        }
        if (new Date(row["started"]).getTime() !== expectedStarted.getTime()) {
          await cl.query("COMMIT");
          return none;
        }

        const started = option(row["started"]).map((v) => new Date(v));
        const lastHeartbeat = option(row["last_heartbeat"]).map(
          (v) => new Date(v),
        );
        const timeout = option(row["timeout"]).map(Number);
        const lastActivity = lastHeartbeat
          .getOrElseValue(started.get)
          .getTime();
        const isStalled = timeout
          .map((ms) => lastActivity + ms < now.getTime())
          .getOrElseValue(false);

        if (!isStalled) {
          await cl.query("COMMIT");
          return none;
        }

        const status =
          Number(row["attempt"]) < Number(row["max_attempts"])
            ? TaskStatus.pending
            : TaskStatus.error;
        const backoff = Number(row["backoff"]);
        const backoffType = String(row["backoff_type"]);
        const retryDelay =
          backoffType === "constant"
            ? backoff
            : backoffType === "linear"
              ? backoff * Number(row["attempt"])
              : backoff * Math.pow(2, Number(row["attempt"]) - 1);

        await cl.query(
          `update tasks_queue
              set finished = $1,
                  error = $2,
                  status = $3,
                  start_after = $4
            where id = $5
              and status = $6`,
          [
            now,
            "Timeout",
            status,
            status === TaskStatus.pending
              ? new Date(now.getTime() + retryDelay)
              : null,
            taskId,
            TaskStatus.in_progress,
          ],
        );

        if (status === TaskStatus.error) {
          await cl.query(
            `update tasks_queue
                set status = $1,
                    start_after = $2,
                    finished = null,
                    error = null
              where id = $3
                and status = $4`,
            [
              TaskStatus.pending,
              now,
              option(row["parent_id"]).orNull,
              TaskStatus.blocked,
            ],
          );
        }

        await cl.query("COMMIT");
        return some(status as TaskStatus);
      } catch (e) {
        await cl.query("ROLLBACK");
        throw e;
      }
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
  async peekNextStartAfter(
    queueNames: HashSet<string>,
    now: Date = new Date(),
  ): Promise<Option<Date>> {
    if (queueNames.isEmpty) {
      return none;
    }
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
  async finish(
    taskId: number,
    nextPayload?: object,
    result?: object,
    expectedStarted?: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `update tasks_queue
                 set status=$1,
                     finished=$2,
                     error=null,
                     payload=$5,
                     result=$6
                 where id = $3
                   and status = $4
                   and started = $7`,
        [
          TaskStatus.finished,
          now,
          taskId,
          TaskStatus.in_progress,
          option(nextPayload).orNull,
          option(result).orNull,
          option(expectedStarted).orNull,
        ],
      );
      return (res.rowCount ?? 0) === 1;
    });
  }

  /**
   * Wake a blocked parent task after its child has reached a terminal state.
   *
   * The parent is moved back to `pending` and becomes immediately eligible for polling.
   * No update is performed if the child has no parent or if the parent is not currently blocked.
   *
   * @param childTaskId child task that has just completed terminally
   * @returns parent id and queue if a blocked parent was woken
   */
  @Metric()
  async wakeParentOnChildTerminal(
    childTaskId: number,
    now: Date = new Date(),
  ): Promise<Option<{ id: number; queue: string }>> {
    return await this.withClient(async (cl) => {
      const res = await cl.query(
        `update tasks_queue p
             set status = $1,
                 start_after = $2,
                 finished = null,
                 error = null
           where p.id = (
               select parent_id
                 from tasks_queue
                where id = $3
           )
             and p.status = $4
           returning p.id, p.queue`,
        [TaskStatus.pending, now, childTaskId, TaskStatus.blocked],
      );
      return Collection.from(res.rows).headOption.map((r) => ({
        id: Number(r["id"]),
        queue: String(r["queue"]),
      }));
    });
  }

  /**
   * Reschedule a periodic task by setting its status back to `pending` and updating `start_after`.
   *
   * This method runs in a transaction and performs two operations:
   * 1) lock and read periodic scheduling parameters (`SELECT ... FOR UPDATE`)
   * 2) update task state and `start_after` using the computed next execution time.
   *
   * Supported periodic sources:
   * - `repeat_interval` for fixed rate / fixed delay modes
   * - `cron_expression` for cron mode
   *
   * Cron expressions support both common formats:
   * - 5-field format: `minute hour day-of-month month day-of-week`
   * - 6-field format: `second minute hour day-of-month month day-of-week`
   *
   * @param taskId the id of the task
   */
  @Metric()
  async rescheduleIfPeriodic(
    taskId: number,
    nextPayload?: object,
    result?: object,
    expectedStarted?: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    return await this.withClient(async (cl) => {
      await cl.query("BEGIN");
      try {
        // Lock the row and read scheduling parameters atomically to avoid races.
        const periodicTask = await this.findPeriodicForReschedule(
          cl,
          taskId,
          option(expectedStarted).orNull,
        );
        const updated = await periodicTask.mapPromise(async (task) => {
          // Compute the next trigger in application code to support both interval and cron schedules.
          const nextStartAfter = PeriodicScheduleUtils.calculateNextStartAfter(
            task,
            now,
          );
          await cl.query(
            `UPDATE tasks_queue
                       SET status      = $1,
                           start_after = $2,
                           finished    = $3,
                           error       = NULL,
                           attempt     = 0,
                           payload     = $6,
                           result      = $7
                     WHERE id = $4
                       AND status = $5
                       AND started = $8`,
            [
              TaskStatus.pending,
              nextStartAfter,
              now,
              taskId,
              TaskStatus.in_progress,
              option(nextPayload).orNull,
              option(result).orNull,
              option(expectedStarted).orNull,
            ],
          );
          return true;
        });
        await cl.query("COMMIT");
        return updated.getOrElseValue(false);
      } catch (e) {
        await cl.query("ROLLBACK");
        throw e;
      }
    });
  }

  private async findPeriodicForReschedule(
    cl: PoolClient,
    taskId: number,
    expectedStarted: Date | null,
  ): Promise<Option<PeriodicScheduleConfig>> {
    const res = await cl.query(
      `SELECT repeat_type,
              repeat_interval,
              cron_expression,
              start_after,
              initial_start,
              missed_runs_strategy
         FROM tasks_queue
        WHERE id = $1
          AND status = $2
          AND started = $6
          AND missed_runs_strategy IS NOT NULL
          AND repeat_type IN ($3, $4, $5)
          AND (
                (repeat_type IN ($3, $4) AND repeat_interval IS NOT NULL)
                OR
                (repeat_type = $5 AND cron_expression IS NOT NULL)
              )
        FOR UPDATE`,
      [
        taskId,
        TaskStatus.in_progress,
        TaskPeriodType.fixed_rate,
        TaskPeriodType.fixed_delay,
        TaskPeriodType.cron,
        expectedStarted,
      ],
    );
    return Collection.from(res.rows).headOption.map((r) => ({
      repeatType:
        TaskPeriodType[r["repeat_type"] as keyof typeof TaskPeriodType],
      repeatInterval: option(r["repeat_interval"]).map(Number),
      cronExpression: option(r["cron_expression"]).map(String),
      startAfter: new Date(r["start_after"]),
      initialStart: new Date(r["initial_start"]),
      missedRunsStrategy:
        MissedRunStrategy[
          r["missed_runs_strategy"] as keyof typeof MissedRunStrategy
        ],
    }));
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
   * @param nextPayload Replaces task payload, if set
   * @returns The new status of the task after the update (`'pending'` or `'error'`).
   */
  @Metric()
  async fail(
    taskId: number,
    error: string,
    nextPayload?: object,
    result?: object,
    expectedStarted?: Date,
    now: Date = new Date(),
  ): Promise<Option<TaskStatus>> {
    return await this.withClient(async (cl) => {
      // TODO: extract shared fail/retry SQL so fail() and failStalled() use one transition definition.
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
                                                                  THEN (backoff * POWER(2, (attempt - 1)))
                                                              ELSE backoff
                                                              END
                                                          ) * interval '1 millisecond'
                                  ELSE NULL
                    END,
                payload     = $7,
                result      = CASE
                                  WHEN attempt < max_attempts THEN NULL
                                  ELSE $8::jsonb
                    END
            WHERE id = $5
              AND status = $6
              AND started = $9
            returning status
        `,
        [
          now, // $1
          error, // $2
          TaskStatus.pending, // $3
          TaskStatus.error, // $4
          taskId, // $5
          TaskStatus.in_progress, // $6
          option(nextPayload).orNull, // $7
          option(result).orNull, // $8
          option(expectedStarted).orNull, // $9
        ],
      );
      return Collection.from(res.rows)
        .headOption.map((r) => TaskStatus[r.status as keyof typeof TaskStatus])
        .map((status) => status as TaskStatus);
    });
  }

  /**
   * Process all stalled in-progress tasks.
   *
   * For each stalled task:
   * - if retries remain, it is requeued back to `pending` using the same backoff formula as regular failures
   * - otherwise, it is marked as terminal `error` with `Timeout`
   *
   * If a terminally failed stalled task is a child task, its blocked parent is woken in the same transaction.
   *
   * To be updated the task should have
   *  - status='in_progress'
   *  - defined timeout and greatest(started, coalesce(last_heartbeat, started)) + timeout
   *    should be less than current timestamp
   *
   * @return ids of stalled tasks whose status was updated
   */
  @Metric()
  async failStalled(now: Date = new Date()): Promise<Collection<number>> {
    return await this.withClient(async (cl) => {
      await cl.query("BEGIN");
      try {
        // TODO: extract shared fail/retry SQL so failStalled() and fail() use one transition definition.
        const res = await cl.query(
          `with updated as (
               update tasks_queue child
                  set finished = $1,
                      error = $2,
                      status = case
                                   when attempt < max_attempts then $3
                                   else $4
                               end,
                      start_after = case
                                        when attempt < max_attempts then
                                            $1::timestamp + (
                                                case backoff_type
                                                    when 'constant' then backoff
                                                    when 'linear' then (backoff * attempt)
                                                    when 'exponential' then (backoff * power(2, (attempt - 1)))
                                                    else backoff
                                                end
                                            ) * interval '1 millisecond'
                                        else null
                                    end
                where child.status = $5
                  and child.timeout is not null
                  and greatest(
                      child.started,
                      coalesce(child.last_heartbeat, child.started)
                  ) + child.timeout * interval '1 millisecond' < $6
                returning child.id, child.parent_id, child.status
             ),
             woken as (
               update tasks_queue parent
                  set status = $3,
                      start_after = $1,
                      finished = null,
                      error = null
                 where parent.id in (
                     select parent_id
                       from updated
                      where parent_id is not null
                        and status = $4
                 )
                   and parent.status = $7
               returning parent.id
             )
             select id
               from updated`,
          [
            now, // $1
            "Timeout", // $2
            TaskStatus.pending, // $3
            TaskStatus.error, // $4
            TaskStatus.in_progress, // $5
            now, // $6
            TaskStatus.blocked, // $7
          ],
        );
        await cl.query("COMMIT");
        return Collection.from(res.rows).map((r) => r.id as number);
      } catch (e) {
        await cl.query("ROLLBACK");
        throw e;
      }
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
   * the time, when the task was finished plus the timeout. Tasks with any unfinished
   * ancestor in the parent chain are preserved.
   *
   * @param timeout the duration between the time, when the task was finished and current timestamp
   */
  @Metric()
  async clearFinished(
    timeout: number = TimeUtils.day,
    now: Date = new Date(),
  ): Promise<void> {
    const expired = new Date(now.getTime() - timeout);
    await this.withClient(async (cl) => {
      await cl.query(
        `with recursive ancestors as (
                   select child.id as task_id, parent.id, parent.parent_id, parent.status
                   from tasks_queue child
                            join tasks_queue parent on parent.id = child.parent_id
                   where child.status = $1
                     and child.finished < $2

                   union all

                   select ancestors.task_id, parent.id, parent.parent_id, parent.status
                   from ancestors
                            join tasks_queue parent on parent.id = ancestors.parent_id
               )
         delete
         from tasks_queue task
         where task.status = $1
           and task.finished < $2
           and not exists (
             select 1
             from ancestors
             where ancestors.task_id = task.id
               and ancestors.status <> $1
           )`,
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
