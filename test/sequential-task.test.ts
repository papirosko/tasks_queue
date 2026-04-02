import { describe, expect, it, jest } from "@jest/globals";
import { Collection, none, some } from "scats";
import { MultiStepPayload } from "../src/multi-step-payload.js";
import { SequentialTask } from "../src/sequential-task.js";
import { TaskContext, TaskStateSnapshot } from "../src/tasks-model.js";

type VideoPayload = {
  videoId: number;
};

class TestSequentialTask extends SequentialTask<
  "scan" | "encode" | "metadata",
  VideoPayload
> {
  constructor() {
    super(Collection.of("scan", "encode", "metadata"));
  }

  protected override async processStep(): Promise<void> {
    return;
  }
}

class RecordingSequentialTask extends SequentialTask<
  "scan" | "encode" | "metadata",
  VideoPayload
> {
  constructor() {
    super(Collection.of("scan", "encode", "metadata"));
  }

  protected override async processStep(): Promise<void> {
    return;
  }
}

class ContextAwareSequentialTask extends SequentialTask<
  "scan" | "encode" | "metadata",
  VideoPayload
> {
  readonly seenResolvedChildStatuses: string[] = [];

  constructor() {
    super(Collection.of("scan", "encode", "metadata"));
  }

  protected override async processStep(
    step: "scan" | "encode" | "metadata",
    _payload: VideoPayload,
    context: TaskContext,
  ): Promise<void> {
    if (step === "encode") {
      context.resolvedChildTask.foreach((childTask) => {
        this.seenResolvedChildStatuses.push(childTask.status);
      });
    }
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
  resolvedChildTask: none,
});

describe("SequentialTask", () => {
  it("delegates processing to processStep with current step and user payload", async () => {
    const task = new RecordingSequentialTask();
    const context = createContext();
    const processStepSpy = jest.spyOn(task as any, "processStep");
    const payload = new MultiStepPayload(
      none,
      { step: "scan" },
      { videoId: 42 },
    );

    await task.process(payload.toJson, context);

    expect(processStepSpy).toHaveBeenCalledWith(
      "scan",
      { videoId: 42 },
      context,
    );
  });

  it("advances to the next step after child success", async () => {
    const task = new TestSequentialTask();
    const context = createContext();
    const processStepSpy = jest.spyOn(task as any, "processStep");
    const payload = new MultiStepPayload(
      none,
      { step: "scan" },
      { videoId: 42 },
    );

    await (task as any).childFinished(
      payload,
      {
        id: 10,
        parentId: 1,
        status: "finished",
        payload: undefined,
        error: undefined,
      } as TaskStateSnapshot,
      context,
    );

    expect(context.setPayload).toHaveBeenCalledWith({
      workflowPayload: { step: "encode" },
      userPayload: { videoId: 42 },
    });
    expect(processStepSpy).toHaveBeenCalledWith(
      "encode",
      { videoId: 42 },
      context,
    );
  });

  it("does not continue processing when current step is the last one", async () => {
    const task = new RecordingSequentialTask();
    const context = createContext();
    const processStepSpy = jest.spyOn(task as any, "processStep");
    const payload = new MultiStepPayload(
      none,
      { step: "metadata" },
      { videoId: 42 },
    );

    await (task as any).childFinished(
      payload,
      {
        id: 10,
        parentId: 1,
        status: "finished",
        payload: undefined,
        error: undefined,
      } as TaskStateSnapshot,
      context,
    );

    expect(context.setPayload).not.toHaveBeenCalled();
    expect(processStepSpy).not.toHaveBeenCalled();
  });

  it("exposes resolvedChildTask to the next sequential step after child completion", async () => {
    const task = new ContextAwareSequentialTask();
    const context = {
      ...createContext(),
      findTask: jest.fn(async () =>
        some({
          id: 10,
          parentId: 1,
          status: "finished",
          payload: undefined,
          error: undefined,
        } as TaskStateSnapshot),
      ),
    };

    await task.process(
      {
        activeChild: {
          taskId: 10,
        },
        workflowPayload: { step: "scan" },
        userPayload: { videoId: 42 },
      },
      context,
    );

    expect(task.seenResolvedChildStatuses).toEqual(["finished"]);
  });
});
