import pg from "pg";
import { Collection, mutable, option } from "scats";
import { TaskStatus } from "../tasks-model";
import { QueueStat, TaskDto, TasksCount, TasksResult } from "./manage.model";

export class ManageTasksQueueService {
  constructor(private readonly pool: pg.Pool) {}

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
