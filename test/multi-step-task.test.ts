import { describe, expect, it, jest } from "@jest/globals";
import { none, some } from "scats";
import { MultiStepPayload } from "../src/multi-step-payload.js";
import { MultiStepTask } from "../src/multi-step-task.js";
import {
  TaskContext,
  TaskStateSnapshot,
  TaskStatus,
} from "../src/tasks-model.js";

class TestMultiStepTask extends MultiStepTask<{ step: string }> {
  protected override async processNext(): Promise<void> {
    return;
  }
}

const createContext = (): TaskContext => ({
  taskId: 1,
  currentAttempt: 1,
  maxAttempts: 3,
  ping: jest.fn(async () => undefined),
  setPayload: jest.fn(),
  findTask: jest.fn(async () => none),
  spawnChild: jest.fn(),
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
          error: undefined,
        } as TaskStateSnapshot),
      ),
    };
    const childFinishedSpy = jest.spyOn(task as any, "childFinished");

    await task.process(
      {
        activeChildId: 42,
        userPayload: { step: "waiting" },
      },
      context,
    );

    expect(context.setPayload).toHaveBeenCalledWith({
      workflowPayload: {},
      userPayload: { step: "waiting" },
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
          error: "boom",
        } as TaskStateSnapshot),
      ),
    };

    await expect(
      task.process(
        {
          activeChildId: 42,
          userPayload: { step: "waiting" },
        },
        context,
      ),
    ).rejects.toThrow("Child task 42 failed: boom");
  });
});
