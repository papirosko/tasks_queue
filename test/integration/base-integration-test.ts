import { StartedPostgreSqlContainer, PostgreSqlContainer } from "@testcontainers/postgresql";
import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { ManageTasksQueueService } from "../../src/manage-tasks-queue.service.js";
import { TasksQueueDao } from "../../src/tasks-queue.dao.js";
import { TasksQueueService } from "../../src/tasks-queue.service.js";

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

  private container: StartedPostgreSqlContainer | undefined;

  async start(): Promise<void> {
    this.container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("testdb")
      .withUsername("test")
      .withPassword("test")
      .start();

    this.pool = new pg.Pool({
      host: this.container.getHost(),
      port: this.container.getPort(),
      database: this.container.getDatabase(),
      user: this.container.getUsername(),
      password: this.container.getPassword(),
    });

    const migrationPath = path.resolve(process.cwd(), "migration.sql");
    const migration = await fs.readFile(migrationPath, "utf8");
    await this.pool.query(migration);

    this.dao = new TasksQueueDao(this.pool);
    this.manage = new ManageTasksQueueService(this.pool);
    this.service = new TasksQueueService(this.dao, this.manage, {
      concurrency: 1,
      runAuxiliaryWorker: false,
      loopInterval: 1000,
    });
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
    await this.pool.query("truncate table tasks_queue restart identity cascade");
  }

  async stop(): Promise<void> {
    if (this.queueServiceStarted) {
      await this.service.stop();
      this.queueServiceStarted = false;
    }
    await this.pool?.end();
    await this.container?.stop();
    this.container = undefined;
  }
}
