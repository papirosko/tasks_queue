import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { Collection, Nil, option } from "scats";
import { MultiStepPayload } from "../../src/multi-step-payload.js";
import { ManagedWorkflowTask } from "../../src/managed-workflow-task.js";
import { TaskContext, TasksWorker, TaskStatus } from "../../src/index.js";
import { BaseIntegrationTest } from "./base-integration-test.js";

type FilePlanPayload = {
  prompt: string;
  plannedFiles?: string[];
  nextFileIndex?: number;
  generatedFiles?: Array<{ path: string; content: string }>;
};

const MANAGED_PARENT_QUEUE = "managed-parent";
const PLAN_FILES_QUEUE = "managed-plan-files";
const GENERATE_FILE_QUEUE = "managed-generate-file";
const INVALID_PARENT_QUEUE = "managed-invalid-parent";
const FAILING_PARENT_QUEUE = "managed-failing-parent";
const FAILING_CHILD_QUEUE = "managed-failing-child";
const CONFLICT_PARENT_QUEUE = "managed-conflict-parent";
const ALLOW_FAILURE_PARENT_QUEUE = "managed-allow-failure-parent";
const ALLOW_FAILURE_CHILD_QUEUE = "managed-allow-failure-child";
const MAX_RUNS_PARENT_QUEUE = "managed-max-runs-parent";
const MAX_RUNS_CHILD_QUEUE = "managed-max-runs-child";
const MAX_RUNS_NO_CHILD_QUEUE = "managed-max-runs-no-child";

class PlanFilesWorker extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    context.submitResult({
      files: ["src/a.ts", "src/b.ts"],
      promptEcho: String(option(payload["prompt"]).getOrElseValue("")),
    });
  }
}

class GenerateFileWorker extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    const path = String(payload["path"]);
    context.submitResult({
      path,
      content: `// generated for ${path}`,
    });
  }
}

class GenerateFilesManagedWorker extends ManagedWorkflowTask<FilePlanPayload> {
  constructor() {
    super(20);
  }

  protected override async run(
    userPayload: FilePlanPayload,
    context: TaskContext,
  ): Promise<void> {
    const resolvedResult = context.resolvedChildTask.flatMap((t) => t.result);

    const plannedFiles = option(userPayload.plannedFiles)
      .map((x) => Collection.from(x))
      .getOrElseValue(Nil);

    const generatedFiles = resolvedResult
      .map((r) => {
        const result = r as Record<string, unknown>;
        return Array.isArray(result["files"])
          ? (result["files"] as string[])
          : [];
      })
      .map((x) => Collection.from(x))
      .getOrElseValue(Nil);

    if (plannedFiles.isEmpty) {
      if (resolvedResult.isEmpty) {
        context.spawnChild({
          queue: PLAN_FILES_QUEUE,
          payload: {
            prompt: userPayload.prompt,
          },
        });
        return;
      }

      context.setPayload({
        ...userPayload,
        plannedFiles: generatedFiles.toArray,
        nextFileIndex: 0,
        generatedFiles: [],
      });
      if (generatedFiles.isEmpty) {
        context.submitResult({
          files: [],
        });
        return;
      }
      context.spawnChild({
        queue: GENERATE_FILE_QUEUE,
        payload: {
          path: generatedFiles.head,
        },
      });
      context.setPayload({
        ...userPayload,
        plannedFiles: generatedFiles.toArray,
        nextFileIndex: 1,
        generatedFiles: [],
      });
      return;
    }

    const currentIndex = option(userPayload.nextFileIndex).getOrElseValue(0);
    const currentGenerated = option(userPayload.generatedFiles)
      .map((x) => Collection.from(x))
      .getOrElseValue(Nil);

    const withResolvedFile = resolvedResult
      .map((r) => {
        const result = r as Record<string, unknown>;
        const path = String(option(result["path"]).getOrElseValue(""));
        const content = String(option(result["content"]).getOrElseValue(""));
        return {
          generatedFiles: [...currentGenerated.toArray, { path, content }],
          nextIndex: currentIndex,
        };
      })
      .getOrElseValue({
        generatedFiles: currentGenerated.toArray,
        nextIndex: currentIndex,
      });

    if (withResolvedFile.generatedFiles.length >= plannedFiles.size) {
      context.setPayload({
        ...userPayload,
        generatedFiles: withResolvedFile.generatedFiles,
        nextFileIndex: withResolvedFile.nextIndex,
      });
      context.submitResult({
        files: withResolvedFile.generatedFiles,
      });
      return;
    }

    const nextPath = plannedFiles.get(withResolvedFile.nextIndex);
    context.setPayload({
      ...userPayload,
      generatedFiles: withResolvedFile.generatedFiles,
      nextFileIndex: withResolvedFile.nextIndex + 1,
    });
    context.spawnChild({
      queue: GENERATE_FILE_QUEUE,
      payload: {
        path: nextPath,
      },
    });
  }
}

class InvalidManagedWorker extends ManagedWorkflowTask<{ name: string }> {
  protected override async run(): Promise<void> {
    return;
  }
}

class AlwaysFailChildWorker extends TasksWorker {
  override async process(): Promise<void> {
    throw new Error("boom");
  }
}

class ParentWithFailingChildWorker extends ManagedWorkflowTask<{
  ticket: string;
}> {
  protected override async run(
    userPayload: { ticket: string },
    context: TaskContext,
  ): Promise<void> {
    context.spawnChild({
      queue: FAILING_CHILD_QUEUE,
      payload: {
        ticket: userPayload.ticket,
      },
      retries: 2,
      backoff: 0,
    });
  }
}

class ConflictingManagedWorker extends ManagedWorkflowTask<{ id: string }> {
  protected override async run(
    userPayload: { id: string },
    context: TaskContext,
  ): Promise<void> {
    context.submitResult({
      id: userPayload.id,
      ok: true,
    });
    context.spawnChild({
      queue: GENERATE_FILE_QUEUE,
      payload: {
        path: "should-not-run.ts",
      },
    });
  }
}

class AlwaysFailAllowFailureChildWorker extends TasksWorker {
  override async process(): Promise<void> {
    throw new Error("allow-failure-boom");
  }
}

class AllowFailureManagedWorker extends ManagedWorkflowTask<{
  orderId: string;
}> {
  protected override async run(
    userPayload: { orderId: string },
    context: TaskContext,
  ): Promise<void> {
    context.spawnChild({
      queue: ALLOW_FAILURE_CHILD_QUEUE,
      allowFailure: true,
      payload: {
        orderId: userPayload.orderId,
      },
      retries: 2,
      backoff: 0,
    });
  }

  protected override async childFailed(
    payload: any,
    childTask: { id: number; error?: string },
    context: TaskContext,
    activeChild: { allowFailure: boolean },
  ): Promise<void> {
    if (activeChild.allowFailure) {
      context.submitResult({
        orderId: payload.userPayload.orderId as string,
        degraded: true,
        childTaskId: childTask.id,
        childError: option(childTask.error).getOrElseValue("Unknown error"),
      });
      return;
    }
    await super.childFailed(
      payload,
      childTask as any,
      context,
      activeChild as any,
    );
  }
}

class ImmediateSuccessChildWorker extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    context.submitResult({
      child: "ok",
      id: String(option(payload["id"]).getOrElseValue("")),
    });
  }
}

class MaxRunsExhaustedWorker extends ManagedWorkflowTask<{ id: string }> {
  constructor() {
    super(1);
  }

  protected override async run(
    userPayload: { id: string },
    context: TaskContext,
  ): Promise<void> {
    context.spawnChild({
      queue: MAX_RUNS_CHILD_QUEUE,
      payload: {
        id: userPayload.id,
      },
    });
  }
}

class MaxRunsNoChildWorker extends ManagedWorkflowTask<{ id: string }> {
  constructor() {
    super(1);
  }

  protected override async run(
    userPayload: { id: string },
    context: TaskContext,
  ): Promise<void> {
    context.submitResult({
      id: userPayload.id,
      done: true,
    });
  }
}

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("ManagedWorkflowTask integration", () => {
  const test = new QueueIntegrationTest();

  const runUntilTerminal = async (
    taskId: number,
    maxTicks: number = 20,
  ): Promise<void> => {
    for (let i = 0; i < maxTicks; i++) {
      const snapshot = await test.manageTasksQueueService.findById(taskId);
      if (snapshot.isDefined) {
        if (
          snapshot.get.status === TaskStatus.finished ||
          snapshot.get.status === TaskStatus.error
        ) {
          return;
        }
      }
      await test.tasksQueueService.runOnce();
    }
    throw new Error(
      `Task ${taskId} did not reach terminal state after ${maxTicks} ticks`,
    );
  };

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker(
      MANAGED_PARENT_QUEUE,
      new GenerateFilesManagedWorker(),
    );
    test.tasksQueueService.registerWorker(
      PLAN_FILES_QUEUE,
      new PlanFilesWorker(),
    );
    test.tasksQueueService.registerWorker(
      GENERATE_FILE_QUEUE,
      new GenerateFileWorker(),
    );
    test.tasksQueueService.registerWorker(
      INVALID_PARENT_QUEUE,
      new InvalidManagedWorker(),
    );
    test.tasksQueueService.registerWorker(
      FAILING_PARENT_QUEUE,
      new ParentWithFailingChildWorker(),
    );
    test.tasksQueueService.registerWorker(
      FAILING_CHILD_QUEUE,
      new AlwaysFailChildWorker(),
    );
    test.tasksQueueService.registerWorker(
      CONFLICT_PARENT_QUEUE,
      new ConflictingManagedWorker(),
    );
    test.tasksQueueService.registerWorker(
      ALLOW_FAILURE_PARENT_QUEUE,
      new AllowFailureManagedWorker(),
    );
    test.tasksQueueService.registerWorker(
      ALLOW_FAILURE_CHILD_QUEUE,
      new AlwaysFailAllowFailureChildWorker(),
    );
    test.tasksQueueService.registerWorker(
      MAX_RUNS_PARENT_QUEUE,
      new MaxRunsExhaustedWorker(),
    );
    test.tasksQueueService.registerWorker(
      MAX_RUNS_CHILD_QUEUE,
      new ImmediateSuccessChildWorker(),
    );
    test.tasksQueueService.registerWorker(
      MAX_RUNS_NO_CHILD_QUEUE,
      new MaxRunsNoChildWorker(),
    );
  });

  beforeEach(async () => {
    await test.reset();
  });

  afterAll(async () => {
    await test.stop();
  });

  it("executes planner plus per-file generation and finishes with explicit result", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: MANAGED_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        prompt: "generate two files",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);
    await runUntilTerminal(parentTaskId.get, 20);

    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.finished);
    expect(parent.get.payload).toEqual({
      workflowPayload: {
        runCount: 4,
      },
      userPayload: {
        prompt: "generate two files",
        plannedFiles: ["src/a.ts", "src/b.ts"],
        nextFileIndex: 2,
        generatedFiles: [
          { path: "src/a.ts", content: "// generated for src/a.ts" },
          { path: "src/b.ts", content: "// generated for src/b.ts" },
        ],
      },
    });
    expect(parent.get.result).toEqual({
      files: [
        { path: "src/a.ts", content: "// generated for src/a.ts" },
        { path: "src/b.ts", content: "// generated for src/b.ts" },
      ],
    });
  });

  it("fails parent when run returns without child spawn and without result", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: INVALID_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        name: "broken",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);
    await runUntilTerminal(parentTaskId.get, 5);

    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.error);
    expect(parent.get.error.orUndefined).toBe(
      "Managed workflow must either spawn a child task or submit a result in each run",
    );
    expect(parent.get.payload).toEqual({
      workflowPayload: {},
      userPayload: {
        name: "broken",
      },
    });
  });

  it("fails parent when workflow payload contains invalid runCount", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: INVALID_PARENT_QUEUE,
      payload: {
        workflowPayload: {
          runCount: "broken-number",
        },
        userPayload: {
          name: "broken-run-count",
        },
      },
    });

    expect(parentTaskId.isDefined).toBe(true);
    await runUntilTerminal(parentTaskId.get, 5);

    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.error);
    expect(parent.get.error.orUndefined).toBe(
      "Invalid workflow runCount value: broken-number. runCount must be a non-negative integer",
    );
  });

  it("fails parent after child reaches terminal error on max-attempts exhaustion", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: FAILING_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        ticket: "INC-42",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

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

    await test.tasksQueueService.runOnce();
    const childAfterFirstFailure =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(childAfterFirstFailure.isDefined).toBe(true);
    expect(childAfterFirstFailure.get.status).toBe(TaskStatus.pending);
    expect(childAfterFirstFailure.get.attempt).toBe(1);
    expect(childAfterFirstFailure.get.error.orUndefined).toBe("boom");

    await test.tasksQueueService.runOnce();
    const childTerminal =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(childTerminal.isDefined).toBe(true);
    expect(childTerminal.get.status).toBe(TaskStatus.error);
    expect(childTerminal.get.attempt).toBe(2);
    expect(childTerminal.get.error.orUndefined).toBe("boom");
    expect(childTerminal.get.result).toBeNull();

    const wokenParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(wokenParent.isDefined).toBe(true);
    expect(wokenParent.get.status).toBe(TaskStatus.pending);

    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe(
      `Child task ${childTaskId} failed: boom`,
    );
    expect(failedParent.get.payload).toEqual({
      activeChild: {
        taskId: childTaskId,
      },
      workflowPayload: {
        runCount: 1,
      },
      userPayload: {
        ticket: "INC-42",
      },
    });
    expect(failedParent.get.result).toBeNull();
  });

  it("fails parent when run calls submitResult and spawnChild in the same pass", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: CONFLICT_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        id: "conflict-1",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);
    await runUntilTerminal(parentTaskId.get, 5);

    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.error);
    expect(parent.get.attempt).toBe(1);
    expect(parent.get.error.orUndefined).toBe(
      "Managed workflow cannot spawn a child after submitting result",
    );
    expect(parent.get.result).toEqual({
      id: "conflict-1",
      ok: true,
    });
    expect(parent.get.payload).toEqual({
      workflowPayload: {},
      userPayload: {
        id: "conflict-1",
      },
    });

    const children = await test.manageTasksQueueService.findByParameters({
      queue: GENERATE_FILE_QUEUE,
      limit: 10,
      offset: 0,
    });
    expect(children.items.isEmpty).toBe(true);
  });

  it("continues parent flow when child with allowFailure=true exhausts attempts", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: ALLOW_FAILURE_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        orderId: "ORD-7",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

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

    await test.tasksQueueService.runOnce();
    const childAfterFirstFailure =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(childAfterFirstFailure.isDefined).toBe(true);
    expect(childAfterFirstFailure.get.status).toBe(TaskStatus.pending);
    expect(childAfterFirstFailure.get.attempt).toBe(1);
    expect(childAfterFirstFailure.get.error.orUndefined).toBe(
      "allow-failure-boom",
    );

    await test.tasksQueueService.runOnce();
    const childTerminal =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(childTerminal.isDefined).toBe(true);
    expect(childTerminal.get.status).toBe(TaskStatus.error);
    expect(childTerminal.get.attempt).toBe(2);
    expect(childTerminal.get.error.orUndefined).toBe("allow-failure-boom");

    const pendingParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(pendingParent.isDefined).toBe(true);
    expect(pendingParent.get.status).toBe(TaskStatus.pending);

    await test.tasksQueueService.runOnce();

    const finishedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(finishedParent.isDefined).toBe(true);
    expect(finishedParent.get.status).toBe(TaskStatus.finished);
    expect(finishedParent.get.result).toEqual({
      orderId: "ORD-7",
      degraded: true,
      childTaskId,
      childError: "allow-failure-boom",
    });
    expect(finishedParent.get.payload).toEqual({
      workflowPayload: {
        runCount: 1,
      },
      userPayload: {
        orderId: "ORD-7",
      },
    });
  });

  it("fails parent when maxRuns is exceeded after resume", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: MAX_RUNS_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({
        id: "max-runs-1",
      }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);
    await runUntilTerminal(parentTaskId.get, 10);

    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.error);
    expect(parent.get.error.orUndefined).toBe(
      "Workflow exceeded maximum parent runs: 2 > 1",
    );
    expect(parent.get.payload).toEqual({
      activeChild: {
        taskId: expect.any(Number),
      },
      workflowPayload: {
        runCount: 1,
      },
      userPayload: {
        id: "max-runs-1",
      },
    });
  });

  it("fails on maxRuns boundary without child-resume path", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: MAX_RUNS_NO_CHILD_QUEUE,
      payload: {
        workflowPayload: {
          runCount: 1,
        },
        userPayload: {
          id: "max-runs-no-child",
        },
      },
    });

    expect(parentTaskId.isDefined).toBe(true);
    await runUntilTerminal(parentTaskId.get, 5);

    const parent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(parent.isDefined).toBe(true);
    expect(parent.get.status).toBe(TaskStatus.error);
    expect(parent.get.error.orUndefined).toBe(
      "Workflow exceeded maximum parent runs: 2 > 1",
    );
    expect(parent.get.payload).toEqual({
      workflowPayload: {
        runCount: 1,
      },
      userPayload: {
        id: "max-runs-no-child",
      },
    });
    expect(parent.get.result).toBeNull();
  });
});
