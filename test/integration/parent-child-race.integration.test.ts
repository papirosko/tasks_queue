import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { mutable } from "scats";
import { MultiStepPayload } from "../../src/multi-step-payload.js";
import { TaskContext, TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { TasksWorker } from "../../src/tasks-worker.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ManualClock } from "./support/manual-clock.js";
import {
  TestTaskEventType,
  TestTaskEventsBus,
} from "./support/task-events-bus.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

class ParentRaceWorker extends TasksWorker {
  private readonly executions = new mutable.HashMap<
    number,
    mutable.ArrayBuffer<{
      context: TaskContext;
      deferred: {
        promise: Promise<void>;
        resolve: () => void;
      };
    }>
  >();

  constructor(private readonly bus: TestTaskEventsBus) {
    super();
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    let resolveFn: (() => void) | undefined;
    const deferred = {
      promise: new Promise<void>((resolve) => {
        resolveFn = resolve;
      }),
      resolve: () => resolveFn!(),
    };
    const runs = this.executions
      .get(context.taskId)
      .getOrElse(() => new mutable.ArrayBuffer());
    runs.append({ context, deferred });
    this.executions.put(context.taskId, runs);
    this.bus.emitStarted(context.taskId, payload);
    await deferred.promise;
  }

  complete(taskId: number, occurrence: number = 1): void {
    const execution = this.executions.get(taskId).get.get(occurrence - 1);
    execution.context.spawnChild({
      queue: "child-race",
      payload: { child: true },
    });
    execution.deferred.resolve();
  }

  reset(): void {
    this.executions.clear();
  }
}

class ChildRaceWorker extends TasksWorker {
  override async process(): Promise<void> {
    return;
  }
}

class RetryingChildParentWorker extends TasksWorker {
  override async process(_payload: any, context: TaskContext): Promise<void> {
    context.spawnChild({
      queue: "child-race-retry",
      payload: { child: true },
      retries: 2,
      timeout: TimeUtils.second,
      backoff: 0,
    });
  }
}

class MultiExecutionChildWorker extends TasksWorker {
  private readonly executions = new mutable.HashMap<
    number,
    mutable.ArrayBuffer<{
      deferred: {
        promise: Promise<void>;
        resolve: () => void;
      };
    }>
  >();

  constructor(private readonly bus: TestTaskEventsBus) {
    super();
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    let resolveFn: (() => void) | undefined;
    const deferred = {
      promise: new Promise<void>((resolve) => {
        resolveFn = resolve;
      }),
      resolve: () => resolveFn!(),
    };
    const runs = this.executions
      .get(context.taskId)
      .getOrElse(() => new mutable.ArrayBuffer());
    runs.append({ deferred });
    this.executions.put(context.taskId, runs);
    this.bus.emitStarted(context.taskId, payload);
    await deferred.promise;
  }

  complete(taskId: number, occurrence: number = 1): void {
    this.executions
      .get(taskId)
      .get.get(occurrence - 1)
      .deferred.resolve();
  }

  reset(): void {
    this.executions.clear();
  }
}

describe("Parent-child race integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const parentWorker = new ParentRaceWorker(bus);
  const retryingChildParentWorker = new RetryingChildParentWorker();
  const childWorker = new MultiExecutionChildWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker("parent-race", parentWorker);
    test.tasksQueueService.registerWorker("child-race", new ChildRaceWorker());
    test.tasksQueueService.registerWorker(
      "parent-child-race",
      retryingChildParentWorker,
    );
    test.tasksQueueService.registerWorker("child-race-retry", childWorker);
  });

  beforeEach(async () => {
    await test.reset();
    bus.reset();
    parentWorker.reset();
    childWorker.reset();
    clock.set(baseTime);
  });

  afterAll(async () => {
    await test.stop();
  });

  it("does not let a stale parent attempt block the retried parent and create a child", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: "parent-race",
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-race" }).toJson,
      retries: 2,
      timeout: TimeUtils.second,
      backoff: 0,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // First parent attempt starts and then stalls into immediate retry.
    const firstRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(parentTaskId.get, 1);
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());
    expect(stalled.toArray).toEqual([parentTaskId.get]);

    // Second parent attempt now owns the task row.
    const secondRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(parentTaskId.get, 2);

    // Completing the stale first attempt must not block the current parent or create any child row.
    parentWorker.complete(parentTaskId.get, 1);
    await firstRun;

    const parentAfterStaleCompletion =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(parentAfterStaleCompletion.isDefined).toBe(true);
    expect(parentAfterStaleCompletion.get.status).toBe(TaskStatus.in_progress);
    expect(parentAfterStaleCompletion.get.attempt).toBe(2);

    const childrenAfterStaleCompletion = await test.db.query(
      `select id
         from tasks_queue
        where parent_id = $1`,
      [parentTaskId.get],
    );
    expect(childrenAfterStaleCompletion.rows).toHaveLength(0);

    // Completing the current attempt must block parent and create exactly one child.
    parentWorker.complete(parentTaskId.get, 2);
    await secondRun;

    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    expect(blockedParent.get.attempt).toBe(1);
    expect(blockedParent.get.payload).toMatchObject({
      activeChild: {
        taskId: expect.any(Number),
      },
    });

    const createdChildren = await test.db.query(
      `select id, queue, payload
         from tasks_queue
        where parent_id = $1`,
      [parentTaskId.get],
    );
    expect(createdChildren.rows).toHaveLength(1);
    expect(createdChildren.rows[0]["queue"]).toBe("child-race");
    expect(createdChildren.rows[0]["payload"]).toEqual({ child: true });

    expect(
      bus
        .events(parentTaskId.get)
        .count((event) => event.type === TestTaskEventType.started),
    ).toBe(2);
  });

  it("does not let a stale child attempt wake the blocked parent", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: "parent-child-race",
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-child-race" })
        .toJson,
      retries: 1,
      timeout: TimeUtils.minute,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Parent spawns retryable child and becomes blocked.
    await test.tasksQueueService.runOnce();
    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    const childTaskId = Number(
      (blockedParent.get.payload as Record<string, any>)["activeChild"][
        "taskId"
      ],
    );

    // First child attempt stalls and moves child back to pending while parent stays blocked.
    const firstChildRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId, 1);
    clock.advance(TimeUtils.second + 1);
    const stalled = await test.tasksQueueDao.failStalled(clock.now());
    expect(stalled.toArray).toEqual([childTaskId]);
    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);

    // Second child attempt now owns the child row.
    const secondChildRun = test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId, 2);

    // Stale first child completion must not wake parent.
    childWorker.complete(childTaskId, 1);
    await firstChildRun;
    const parentAfterStaleChildCompletion =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(parentAfterStaleChildCompletion.isDefined).toBe(true);
    expect(parentAfterStaleChildCompletion.get.status).toBe(TaskStatus.blocked);

    // Current child attempt completes and only then parent may wake.
    childWorker.complete(childTaskId, 2);
    await secondChildRun;
    const pendingParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(pendingParent.isDefined).toBe(true);
    expect(pendingParent.get.status).toBe(TaskStatus.pending);
  });
});
