import pg from "pg";
import { Collection, mutable, option, Option } from "scats";
import { TaskPeriodType, TaskStatus } from "./tasks-model.js";
import {
  FindTasksParameters,
  QueueStat,
  TaskDto,
  TasksCount,
  TasksResult,
  UpdatePendingPeriodicScheduleDetails,
  UpdatePendingTaskDetails,
} from "./manage.model.js";
import { CronExpressionUtils } from "./cron-expression-utils.js";

/**
 * Operational management service for inspecting and mutating queued tasks.
 *
 * This service is intended for admin panels, support tooling, and maintenance
 * workflows. It does not execute tasks itself; execution belongs to
 * {@link TasksQueueService} and {@link TasksPoolsService}.
 *
 * See also {@link TaskDto}, {@link TasksResult}, {@link QueueStat}, and
 * {@link TasksCount}.
 */
export class ManageTasksQueueService {
  constructor(private readonly pool: pg.Pool) {}

  private mapTaskRow(row: any): TaskDto {
    return new TaskDto(
      row["id"],
      option(row["parent_id"]).map(Number),
      row["queue"],
      row["created"],
      row["initial_start"],
      option(row["started"]),
      option(row["finished"]),
      row["status"],
      row["missed_runs_strategy"],
      row["priority"],
      option(row["error"]),
      row["backoff"],
      row["backoff_type"],
      row["timeout"],
      option(row["name"]),
      option(row["start_after"]),
      option(row["repeat_interval"]),
      option(row["cron_expression"]),
      option(row["repeat_type"]),
      row["max_attempts"],
      row["attempt"],
      row["payload"],
      row["result"],
    );
  }

  /**
   * Finds a task by its identifier.
   *
   * Returns the full management view of the task if it exists, otherwise `none`.
   *
   * @param taskId task identifier
   * @returns task details wrapped in Option
   */
  async findById(taskId: number): Promise<Option<TaskDto>> {
    const res = await this.pool.query(
      `select *
             from tasks_queue
             where id = $1`,
      [taskId],
    );

    return Collection.from(res.rows).headOption.map((row) =>
      this.mapTaskRow(row),
    );
  }

  /**
   * Finds tasks using optional management filters.
   *
   * Supported filters currently include task status and queue name.
   *
   * @param params search and pagination parameters
   * @returns paginated tasks result
   */
  async findByParameters(params: FindTasksParameters): Promise<TasksResult> {
    const parts = new mutable.ArrayBuffer<string>();
    const queryParams = new mutable.ArrayBuffer<any>();

    option(params.status).foreach((status) => {
      queryParams.append(status);
      parts.append(`status = $${queryParams.size}`);
    });
    option(params.queue).foreach((queue) => {
      queryParams.append(queue);
      parts.append(`queue = $${queryParams.size}`);
    });

    const where = parts.nonEmpty ? `where ${parts.mkString(" and ")}` : "";
    const paginationParams = queryParams.appendedAll([
      params.limit,
      params.offset,
    ]);

    const res = await this.pool.query(
      `select *
             from tasks_queue ${where}
             order by created desc
             limit $${queryParams.size + 1} offset $${queryParams.size + 2}`,
      paginationParams.toArray,
    );

    const total = await this.pool.query(
      `select count(*) as total
                                             from tasks_queue ${where}`,
      queryParams.toArray,
    );

    const items = Collection.from(res.rows).map((row) => this.mapTaskRow(row));

    return new TasksResult(items, total.rows[0]["total"]);
  }

  /**
   * Count tasks currently in terminal `error` state.
   *
   * @returns number of failed tasks as returned by PostgreSQL
   */
  async failedCount() {
    const res = await this.pool.query(
      `select count(*) as total
             from tasks_queue
             where status = '${TaskStatus.error}'`,
    );
    return res.rows[0]["total"];
  }

  /**
   * Delete all tasks currently in terminal `error` state.
   *
   * This is a bulk cleanup operation and does not filter by queue.
   *
   * @returns PostgreSQL query promise for the delete operation
   */
  clearFailed() {
    return this.pool.query(`delete
                                from tasks_queue
                                where status = '${TaskStatus.error}'`);
  }

  /**
   * Deletes a task by id only when it is safe to remove from the queue.
   *
   * Deletion is allowed only for tasks in one of the terminal or inactive states:
   * - `pending`
   * - `error`
   * - `finished`
   *
   * Tasks in `in_progress` state are never deleted because removing an actively
   * processed task can break worker execution semantics. Tasks that still have
   * an unfinished ancestor in the parent chain are also preserved, because
   * removing them can break parent-child workflow recovery.
   *
   * @param taskId task identifier
   * @returns true if the task was deleted, false if it was not found or is in a non-deletable status
   */
  async deleteTask(taskId: number): Promise<boolean> {
    const res = await this.pool.query(
      `
            with recursive ancestors as (
                select parent.id, parent.parent_id, parent.status
                from tasks_queue child
                         join tasks_queue parent on parent.id = child.parent_id
                where child.id = $1

                union all

                select parent.id, parent.parent_id, parent.status
                from ancestors
                         join tasks_queue parent on parent.id = ancestors.parent_id
            )
            delete
            from tasks_queue
            where id = $1
              and status in ($2, $3, $4)
              and not exists (
                select 1
                from ancestors
                where status <> $5
              )
        `,
      [
        taskId,
        TaskStatus.pending,
        TaskStatus.error,
        TaskStatus.finished,
        TaskStatus.finished,
      ],
    );
    return option(res.rowCount).getOrElseValue(0) > 0;
  }

  /**
   * Updates the editable runtime configuration of a pending task.
   *
   * Only tasks currently in `pending` state can be updated. This method changes
   * task execution and retry settings, but does not modify periodic scheduling fields.
   *
   * @param taskId task identifier
   * @param details full replacement of editable task fields
   * @returns true if the pending task was updated, false if it was not found or is no longer pending
   */
  async updatePendingTask(
    taskId: number,
    details: UpdatePendingTaskDetails,
  ): Promise<boolean> {
    if (details.timeout <= 0) {
      throw new Error("Task timeout must be greater than 0");
    }
    if (details.retries <= 0) {
      throw new Error("Task retries must be greater than 0");
    }
    if (details.backoff < 0) {
      throw new Error("Task backoff must be greater than or equal to 0");
    }

    const res = await this.pool.query(
      `
            update tasks_queue
            set start_after = $2,
                priority = $3,
                timeout = $4,
                payload = $5,
                max_attempts = $6,
                backoff = $7,
                backoff_type = $8
            where id = $1
              and status = '${TaskStatus.pending}'
        `,
      [
        taskId,
        details.startAfter,
        details.priority,
        details.timeout,
        details.payload,
        details.retries,
        details.backoff,
        details.backoffType,
      ],
    );
    return option(res.rowCount).getOrElseValue(0) > 0;
  }

  /**
   * Updates the periodic schedule of a pending periodic task.
   *
   * Only tasks currently in `pending` state and already configured as periodic can be updated.
   * This method changes scheduling fields only and does not modify payload, priority, timeout,
   * or retry settings.
   *
   * @param taskId task identifier
   * @param details full replacement of editable periodic scheduling fields
   * @returns true if the pending periodic task was updated, false if it was not found, is not periodic, or is no longer pending
   */
  async updatePendingPeriodicSchedule(
    taskId: number,
    details: UpdatePendingPeriodicScheduleDetails,
  ): Promise<boolean> {
    switch (details.repeatType) {
      case TaskPeriodType.fixed_rate:
      case TaskPeriodType.fixed_delay:
        if (details.period <= 0) {
          throw new Error("Periodic task period must be greater than 0");
        }
        break;
      case TaskPeriodType.cron:
        CronExpressionUtils.validate(details.cronExpression);
        break;
    }

    const repeatInterval =
      details.repeatType === TaskPeriodType.cron ? null : details.period;
    const cronExpression =
      details.repeatType === TaskPeriodType.cron
        ? details.cronExpression
        : null;

    const res = await this.pool.query(
      `
            update tasks_queue
            set start_after = $2,
                initial_start = $3,
                repeat_type = $4,
                repeat_interval = $5,
                cron_expression = $6,
                missed_runs_strategy = $7
            where id = $1
              and status = '${TaskStatus.pending}'
              and repeat_type is not null
        `,
      [
        taskId,
        details.startAfter,
        details.initialStart,
        details.repeatType,
        repeatInterval,
        cronExpression,
        details.missedRunStrategy,
      ],
    );
    return option(res.rowCount).getOrElseValue(0) > 0;
  }

  /**
   * Compute queue-level wait-time percentiles.
   *
   * Wait time is measured as `started - created` for first-attempt executions
   * only. Results are grouped by queue and returned in seconds.
   *
   * @returns queue wait-time percentile stats
   */
  async waitTimeByQueue(): Promise<Collection<QueueStat>> {
    const res = await this.pool.query(`
            SELECT queue,
                   percentile_disc(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started - created)))  AS p50,
                   percentile_disc(0.75) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started - created)))  AS p75,
                   percentile_disc(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started - created)))  AS p95,
                   percentile_disc(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started - created)))  AS p99,
                   percentile_disc(0.999) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started - created))) AS p999
            FROM tasks_queue
            WHERE started IS NOT NULL
              and attempt = 1
            GROUP BY queue
            ORDER BY queue
        `);

    return Collection.from(res.rows).map(
      (row) =>
        new QueueStat(
          row["queue"],
          Number(row["p50"]),
          Number(row["p75"]),
          Number(row["p95"]),
          Number(row["p99"]),
          Number(row["p999"]),
        ),
    );
  }

  /**
   * Restart a single failed task by resetting it back to `pending`.
   *
   * This operation affects only tasks currently in terminal `error` state and
   * resets their attempt counter to `0`.
   *
   * @param taskId task identifier
   * @returns resolved promise when the update completes
   */
  async restartFailedTask(taskId: number) {
    await this.pool.query(
      `
            update tasks_queue
            set status='${TaskStatus.pending}',
                attempt=0
            where id = $1
              and status = '${TaskStatus.error}'
        `,
      [taskId],
    );
  }

  /**
   * Restart all failed tasks in the selected queue.
   *
   * Only tasks currently in terminal `error` state are affected.
   *
   * @param queue queue name
   * @returns resolved promise when the update completes
   */
  async restartAllFailedInQueue(queue: string) {
    await this.pool.query(
      `
            update tasks_queue
            set status='${TaskStatus.pending}',
                attempt=0
            where queue = $1
              and status = '${TaskStatus.error}'
        `,
      [queue],
    );
  }

  /**
   * Count tasks grouped by queue and status.
   *
   * This method is used both by management UIs and by the auxiliary worker's
   * metrics synchronization.
   *
   * @returns queue/status aggregate counts
   */
  async tasksCount(): Promise<Collection<TasksCount>> {
    const res = await this.pool.query(`
            SELECT queue,
                   status,
                   COUNT(*) AS task_count
            FROM tasks_queue
            GROUP BY queue, status
            ORDER BY queue, status
        `);

    return Collection.from(res.rows).map(
      (row) =>
        new TasksCount(
          row["queue"],
          TaskStatus[row["status"] as keyof typeof TaskStatus],
          Number(row["task_count"]),
        ),
    );
  }

  /**
   * Compute queue-level work-time percentiles.
   *
   * Work time is measured as `finished - started` for tasks that have both
   * timestamps. Results are grouped by queue and returned in seconds.
   *
   * @returns queue work-time percentile stats
   */
  async workTimeByQueue(): Promise<Collection<QueueStat>> {
    const res = await this.pool.query(`
            SELECT queue,
                   percentile_disc(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished - started)))  AS p50,
                   percentile_disc(0.75) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished - started)))  AS p75,
                   percentile_disc(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished - started)))  AS p95,
                   percentile_disc(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished - started)))  AS p99,
                   percentile_disc(0.999) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished - started))) AS p999
            FROM tasks_queue
            WHERE started IS NOT NULL
              AND finished IS NOT NULL
            GROUP BY queue
            ORDER BY queue
        `);

    return Collection.from(res.rows).map(
      (row) =>
        new QueueStat(
          row["queue"],
          Number(row["p50"]),
          Number(row["p75"]),
          Number(row["p95"]),
          Number(row["p99"]),
          Number(row["p999"]),
        ),
    );
  }
}
