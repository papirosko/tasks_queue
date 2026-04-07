import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { Collection } from "scats";
import { DEFAULT_POOL, TasksPoolsService } from "../../src/tasks-pools.service.js";
import { MultiStepPayload } from "../../src/multi-step-payload.js";
import { SequentialTask } from "../../src/sequential-task.js";
import { TaskContext, TaskStatus } from "../../src/tasks-model.js";
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ControlledTestWorker } from "./support/controlled-test-worker.js";
import { TestTaskEventsBus } from "./support/task-events-bus.js";

const CROSS_POOL_PARENT_QUEUE = "cross-pool-parent";
const CROSS_POOL_CHILD_QUEUE = "cross-pool-child";
const CHILD_POOL = "child-pool";

class QueueIntegrationTest extends BaseIntegrationTest {}

class CrossPoolParentWorker extends SequentialTask<
  "child" | "done",
  {
    input: string;
    childResult?: {
      ok: boolean;
    };
  }
> {
  constructor(private readonly eventsBus: TestTaskEventsBus) {
    super(Collection.of("child", "done"));
  }

  override starting(taskId: number, payload: any): void {
    this.eventsBus.emitStarted(taskId, payload);
  }

  override async completed(taskId: number): Promise<void> {
    this.eventsBus.emitCompleted(taskId, { completed: true });
  }

  override async failed(
    taskId: number,
    _payload: any,
    _finalStatus: TaskStatus,
    error: any,
  ): Promise<void> {
    const message =
      error !== undefined &&
      error !== null &&
      "message" in (error as Record<string, unknown>)
        ? String((error as { message: unknown }).message)
        : String(error);
    this.eventsBus.emitFailed(taskId, message);
  }

  protected override async processStep(
    step: "child" | "done",
    payload: {
      input: string;
      childResult?: {
        ok: boolean;
      };
    },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "child":
        context.spawnChild({
          queue: CROSS_POOL_CHILD_QUEUE,
          payload: {
            input: payload.input,
          },
        });
        return;
      case "done": {
        const childResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as { ok: boolean } | undefined;
        context.setPayload({
          ...payload,
          childResult,
        });
        context.submitResult({
          input: payload.input,
          childResult,
        });
        return;
      }
    }
  }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs),
    ),
  ]);
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

describe("Cross-pool parent-child notification integration", () => {
  const test = new QueueIntegrationTest();
  const parentBus = new TestTaskEventsBus();
  const childBus = new TestTaskEventsBus();
  const childWorker = new ControlledTestWorker(childBus);
  const parentWorker = new CrossPoolParentWorker(parentBus);
  let poolsService: TasksPoolsService;

  beforeAll(async () => {
    await test.start();
    poolsService = new TasksPoolsService(
      test.tasksQueueDao,
      test.manageTasksQueueService,
      false,
      [
        {
          name: DEFAULT_POOL,
          concurrency: 1,
          loopInterval: TimeUtils.minute,
        },
        {
          name: CHILD_POOL,
          concurrency: 1,
          loopInterval: TimeUtils.minute,
        },
      ],
    );
    poolsService.registerWorker(CROSS_POOL_PARENT_QUEUE, parentWorker);
    poolsService.registerWorker(CROSS_POOL_CHILD_QUEUE, childWorker, CHILD_POOL);
    poolsService.start();
  });

  beforeEach(async () => {
    await test.reset();
    parentBus.reset();
    childBus.reset();
    childWorker.reset();
  });

  afterAll(async () => {
    await poolsService.stop();
    await test.stop();
  });

  it("starts cross-pool children and wakes parent immediately without waiting for loopInterval", async () => {
    const parentTaskId = await poolsService.schedule({
      queue: CROSS_POOL_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        input: "demo",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    await withTimeout(
      parentBus.waitForStarted(parentTaskId.get, 1),
      2000,
      "Parent did not start its first pass promptly",
    );

    const blockedParent = await withTimeout(
      waitForTaskState(test, parentTaskId.get, TaskStatus.blocked),
      2000,
      "Parent did not block after spawning cross-pool child",
    );

    const childTaskId = Number(
      (blockedParent.payload as Record<string, any>)["activeChild"]["taskId"],
    );

    await withTimeout(
      childBus.waitForStarted(childTaskId),
      2000,
      "Cross-pool child was not started promptly",
    );

    childWorker.complete(childTaskId, { ok: true });

    await withTimeout(
      childBus.waitForCompleted(childTaskId),
      2000,
      "Cross-pool child did not complete promptly",
    );

    await withTimeout(
      parentBus.waitForStarted(parentTaskId.get, 2),
      2000,
      "Parent was not woken promptly after cross-pool child completion",
    );

    await withTimeout(
      parentBus.waitForCompleted(parentTaskId.get),
      2000,
      "Parent did not complete promptly after wake-up",
    );

    const finishedParent = await withTimeout(
      waitForTaskState(test, parentTaskId.get, TaskStatus.finished),
      2000,
      "Parent did not reach finished state promptly",
    );
    expect(finishedParent.result).toEqual({
      input: "demo",
      childResult: { ok: true },
    });
  });
});

const waitForTaskState = async (
  test: QueueIntegrationTest,
  taskId: number,
  status: TaskStatus,
): Promise<{
  payload: object;
  result: object | null;
}> => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = await test.manageTasksQueueService.findById(taskId);
    if (task.isDefined && task.get.status === status) {
      return {
        payload: task.get.payload,
        result: task.get.result,
      };
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for task ${taskId} to reach status ${status}`);
};
