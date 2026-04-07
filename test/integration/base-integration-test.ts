import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { ManageTasksQueueService } from "../../src/manage-tasks-queue.service.js";
import { TasksQueueDao } from "../../src/tasks-queue.dao.js";
import { TasksQueueService } from "../../src/tasks-queue.service.js";
import { Clock, SystemClock } from "../../src/clock.js";

/**
 * Minimal integration-test harness for repository-level tests against real Postgres.
 *
 * The harness owns container lifecycle, applies the SQL migration once on startup,
 * and provides helpers for resetting database state between tests.
 */
export abstract class BaseIntegrationTest {
  protected pool!: pg.Pool;
  protected dao!: TasksQueueDao;
  protected manage!: ManageTasksQueueService;
  protected service!: TasksQueueService;
  private queueServiceStarted = false;
  protected readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  async start(): Promise<void> {
    const statePath = path.resolve(
      process.cwd(),
      "test",
      "integration",
      "global-setup.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    };

    this.pool = new pg.Pool({
      host: state.host,
      port: state.port,
      database: state.database,
      user: state.user,
      password: state.password,
    });

    await this.pool.query(`DROP SCHEMA IF EXISTS "public" CASCADE`);
    await this.pool.query(`CREATE SCHEMA "public"`);

    const migrationPath = path.resolve(process.cwd(), "migration.sql");
    const migration = await fs.readFile(migrationPath, "utf8");
    await this.pool.query(migration);

    this.dao = new TasksQueueDao(this.pool);
    this.manage = new ManageTasksQueueService(this.pool);
    this.service = new TasksQueueService(
      this.dao,
      this.manage,
      {
        concurrency: 1,
        runAuxiliaryWorker: false,
        loopInterval: 1000,
      },
      this.clock,
    );
  }

  get db(): pg.Pool {
    return this.pool;
  }

  get tasksQueueDao(): TasksQueueDao {
    return this.dao;
  }

  get manageTasksQueueService(): ManageTasksQueueService {
    return this.manage;
  }

  get tasksQueueService(): TasksQueueService {
    return this.service;
  }

  startQueueService(): void {
    this.service.start();
    this.queueServiceStarted = true;
  }

  async reset(): Promise<void> {
    await this.pool.query(
      "truncate table tasks_queue restart identity cascade",
    );
  }

  async stop(): Promise<void> {
    if (this.queueServiceStarted) {
      await this.service.stop();
      this.queueServiceStarted = false;
    }
    await this.pool.end();
  }
}
