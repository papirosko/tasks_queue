import { describe, expect, it, jest } from "@jest/globals";
import { none, some, type Option } from "scats";
import { ActiveChildState } from "../src/active-child-state.js";
import { MultiStepPayload } from "../src/multi-step-payload.js";
import { MultiStepTask } from "../src/multi-step-task.js";
import {
  TaskContext,
  TaskStateSnapshot,
  TaskStatus,
} from "../src/tasks-model.js";

class TestMultiStepTask extends MultiStepTask<{ step: string }> {
  protected override async processNext(
    _payload: MultiStepPayload<{ step: string }>,
    _context: TaskContext,
  ): Promise<void> {
    return;
  }
}

class AllowFailureMultiStepTask extends MultiStepTask<{ step: string }> {
  protected override async processNext(
    _payload: MultiStepPayload<{ step: string }>,
    _context: TaskContext,
  ): Promise<void> {
    return;
  }

  protected override async childFailed(
    payload: MultiStepPayload<{ step: string }>,
    childTask: { id: number; error?: string },
    context: TaskContext,
    activeChild: ActiveChildState,
  ): Promise<void> {
    if (activeChild.allowFailure) {
      await this.processNext(payload, context);
      return;
    }
    await super.childFailed(payload, childTask, context, activeChild);
  }
}

class ResultAwareMultiStepTask extends MultiStepTask<{ step: string }> {
  childResult: Option<object> = none;

  protected override async processNext(): Promise<void> {
    return;
  }

  protected override async childFinished(
    _payload: MultiStepPayload<{ step: string }>,
    childTask: TaskStateSnapshot,
  ): Promise<void> {
    this.childResult = childTask.result;
  }
}

const createContext = (): TaskContext => ({
  taskId: 1,
  currentAttempt: 1,
  maxAttempts: 3,
  ping: jest.fn(async () => undefined),
  setPayload: jest.fn(),
  submitResult: jest.fn(),
  findTask: jest.fn(async () => none),
  spawnChild: jest.fn(),
  resolvedChildTask: none,
});

describe("MultiStepTask", () => {
  it("runs next step when there is no active child", async () => {
    const task = new TestMultiStepTask();
    const context = createContext();
    const processNextSpy = jest.spyOn(task as any, "processNext");
    const payload = new MultiStepPayload(none, {}, { step: "start" });

    await task.process(payload.toJson, context);

    expect(processNextSpy).toHaveBeenCalledWith(payload, context);
    expect(context.findTask).not.toHaveBeenCalled();
  });

  it("clears active child id and routes finished child to childFinished", async () => {
    const task = new TestMultiStepTask();
    const context = {
      ...createContext(),
      findTask: jest.fn(async () =>
        some({
          id: 42,
          parentId: 1,
          status: TaskStatus.finished,
          payload: undefined,
          result: some({ child: "result" }),
          error: undefined,
        } as TaskStateSnapshot),
      ),
    };
    const childFinishedSpy = jest.spyOn(task as any, "childFinished");

    await task.process(
      {
        activeChild: {
          taskId: 42,
        },
        userPayload: { step: "waiting" },
      },
      context,
    );

    expect(context.setPayload).toHaveBeenCalledWith({
      workflowPayload: {},
      userPayload: { step: "waiting" },
    });
    expect(context.resolvedChildTask.isDefined).toBe(true);
    context.resolvedChildTask.foreach((childTask) => {
      expect(childTask).toEqual({
        id: 42,
        parentId: 1,
        status: TaskStatus.finished,
        payload: undefined,
        result: some({ child: "result" }),
        error: undefined,
      });
    });
    expect(childFinishedSpy).toHaveBeenCalled();
  });

  it("fails by default when child has terminal error", async () => {
    const task = new TestMultiStepTask();
    const context = {
      ...createContext(),
      findTask: jest.fn(async () =>
        some({
          id: 42,
          parentId: 1,
          status: TaskStatus.error,
          payload: undefined,
          result: some({ child: "result" }),
          error: "boom",
        } as TaskStateSnapshot),
      ),
    };

    await expect(
      task.process(
        {
          activeChild: {
            taskId: 42,
          },
          userPayload: { step: "waiting" },
        },
        context,
      ),
    ).rejects.toThrow("Child task 42 failed: boom");
  });

  it("continues workflow when child failure is allowed", async () => {
    const task = new AllowFailureMultiStepTask();
    const context = {
      ...createContext(),
      findTask: jest.fn(async () =>
        some({
          id: 42,
          parentId: 1,
          status: TaskStatus.error,
          payload: undefined,
          result: some({ child: "result" }),
          error: "boom",
        } as TaskStateSnapshot),
      ),
    };
    const processNextSpy = jest.spyOn(task as any, "processNext");

    await task.process(
      {
        activeChild: {
          taskId: 42,
          allowFailure: true,
        },
        userPayload: { step: "waiting" },
      },
      context,
    );

    expect(context.setPayload).toHaveBeenCalledWith({
      workflowPayload: {},
      userPayload: { step: "waiting" },
    });
    expect(context.resolvedChildTask.isDefined).toBe(true);
    context.resolvedChildTask.foreach((childTask) => {
      expect(childTask).toEqual({
        id: 42,
        parentId: 1,
        status: TaskStatus.error,
        payload: undefined,
        result: some({ child: "result" }),
        error: "boom",
      });
    });
    expect(processNextSpy).toHaveBeenCalledWith(
      new MultiStepPayload(none, {}, { step: "waiting" }),
      context,
    );
  });

  it("exposes child result separately from child payload", async () => {
    const task = new ResultAwareMultiStepTask();
    const context = {
      ...createContext(),
      findTask: jest.fn(async () =>
        some({
          id: 42,
          parentId: 1,
          status: TaskStatus.finished,
          payload: { internal: true },
          result: some({ output: true }),
          error: undefined,
        } as TaskStateSnapshot),
      ),
    };

    await task.process(
      {
        activeChild: {
          taskId: 42,
        },
        userPayload: { step: "waiting" },
      },
      context,
    );

    expect(task.childResult.orUndefined).toEqual({ output: true });
  });

  it("reads legacy activeChildId payloads for backward compatibility", async () => {
    const payload = MultiStepPayload.fromJson<{ step: string }>({
      activeChildId: 42,
      workflowPayload: { stage: "scan" },
      userPayload: { step: "waiting" },
    });

    expect(payload.activeChild.isDefined).toBe(true);
    payload.activeChild.foreach((activeChild) => {
      expect(activeChild.taskId).toBe(42);
      expect(activeChild.allowFailure).toBe(false);
    });
  });
});
