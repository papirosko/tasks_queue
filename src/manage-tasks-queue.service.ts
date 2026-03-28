import pg from "pg";
import { Collection, mutable, option, Option } from "scats";
import { TaskPeriodType, TaskStatus } from "./tasks-model.js";
import {
  QueueStat,
  TaskDto,
  TasksCount,
  TasksResult,
  UpdatePendingPeriodicScheduleDetails,
  UpdatePendingTaskDetails,
} from "./manage.model.js";
import { CronExpressionUtils } from "./cron-expression-utils.js";

export class ManageTasksQueueService {
  constructor(private readonly pool: pg.Pool) {}

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

    return Collection.from(res.rows).headOption.map(
      (row) =>
        new TaskDto(
          row["id"],
          row["queue"],
          row["created"],
          row["initial_start"],
          option(row["started"]),
          option(row["finished"]),
          row["status"],
          row["missed_run_strategy"],
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
        ),
    );
  }

  async findByStatus(params: {
    status?: TaskStatus;
    offset: number;
    limit: number;
  }): Promise<TasksResult> {
    const parts = new mutable.ArrayBuffer<string>();
    option(params.status).foreach((status) => {
      parts.append(`status='${status}'`);
    });

    const where = parts.nonEmpty ? `where ${parts.toArray.join(" and ")}` : "";

    const res = await this.pool.query(
      `select *
             from tasks_queue ${where}
             order by created desc
             limit $1 offset $2`,
      [params.limit, params.offset],
    );

    const total = await this.pool.query(`select count(*) as total
                                             from tasks_queue ${where}`);

    const items = Collection.from(res.rows).map((row) => {
      return new TaskDto(
        row["id"],
        row["queue"],
        row["created"],
        row["initial_start"],
        option(row["started"]),
        option(row["finished"]),
        row["status"],
        row["missed_run_strategy"],
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
      );
    });

    return new TasksResult(items, total.rows[0]["total"]);
  }

  async failedCount() {
    const res = await this.pool.query(
      `select count(*) as total
             from tasks_queue
             where status = '${TaskStatus.error}'`,
    );
    return res.rows[0]["total"];
  }

  clearFailed() {
    return this.pool.query(`delete
                                from tasks_queue
                                where status = '${TaskStatus.error}'`);
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
    return (res.rowCount ?? 0) > 0;
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
    return (res.rowCount ?? 0) > 0;
  }

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
