import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { mutable } from "scats";
import { TaskContext, TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";
import { TestTaskEventsBus } from "./support/task-events-bus.js";
import { TasksWorker } from "../../src/tasks-worker.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

class HeartbeatControlledWorker extends TasksWorker {
  private readonly contexts = new mutable.HashMap<number, TaskContext>();

  constructor(private readonly bus: TestTaskEventsBus) {
    super();
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    this.contexts.put(context.taskId, context);
    this.bus.emitStarted(context.taskId, payload);
    await new Promise<void>(() => undefined);
  }

  async ping(taskId: number): Promise<void> {
    await this.contexts.get(taskId).get.ping();
  }

  reset(): void {
    this.contexts.clear();
  }
}

describe("Stalled heartbeat integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const worker = new HeartbeatControlledWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker("email", worker);
  });

  beforeEach(async () => {
    await test.reset();
    bus.reset();
    worker.reset();
    clock.set(baseTime);
  });

  afterAll(async () => {
    await test.stop();
  });

  it("marks in-progress task as stalled after timeout without heartbeat", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
      timeout: TimeUtils.second,
    });

    // Start the task and leave it running without any heartbeat updates.
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    // Move clock past timeout and ask DAO to detect stalled tasks.
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());

    // Confirm that the running task was marked as timed out in persistent storage.
    expect(stalled.toArray).toEqual([taskId.get]);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.error);
    expect(task.get.error.orUndefined).toBe("Timeout");
    expect(task.get.payload).toEqual(payload);
  });

  it("does not stall task when heartbeat was refreshed in time", async () => {
    const payload = { userId: 42 };
    const taskId = await test.tasksQueueService.schedule({
      queue: "email",
      payload,
      retries: 1,
      timeout: TimeUtils.second,
    });

    // Start the task and refresh its heartbeat before the timeout threshold.
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(taskId.get);

    clock.advance(TimeUtils.second - 100);
    await worker.ping(taskId.get);

    // Move slightly forward and verify that the refreshed heartbeat prevents stalling.
    clock.advance(200);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());

    expect(stalled.toArray).toEqual([]);
    const task = await test.manageTasksQueueService.findById(taskId.get);
    expect(task.isDefined).toBe(true);
    expect(task.get.status).toBe(TaskStatus.in_progress);
    expect(task.get.payload).toEqual(payload);
  });
});
