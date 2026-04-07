import { describe, expect, it, jest } from "@jest/globals";
import { Collection, mutable, none, some } from "scats";
import { ActiveChildState } from "../src/active-child-state.js";
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
  readonly seenResolvedChildStatuses = new mutable.ArrayBuffer<string>();

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
        this.seenResolvedChildStatuses.append(childTask.status);
      });
    }
  }
}

class PayloadUpdatingSequentialTask extends SequentialTask<
  "scan" | "encode" | "metadata",
  VideoPayload & { encodedPath?: string }
> {
  constructor() {
    super(Collection.of("scan", "encode", "metadata"));
  }

  protected override async processStep(
    step: "scan" | "encode" | "metadata",
    payload: VideoPayload & { encodedPath?: string },
    context: TaskContext,
  ): Promise<void> {
    if (step === "encode") {
      context.setPayload({
        ...payload,
        encodedPath: "/videos/42.mp4",
      });
    }
  }
}

class AutoContinuingSequentialTask extends SequentialTask<
  "scan" | "encode" | "metadata",
  VideoPayload & { encodedPath?: string }
> {
  readonly visitedSteps = new mutable.ArrayBuffer<string>();
  readonly metadataResolvedChildStatuses = new mutable.ArrayBuffer<string>();
  readonly metadataSeenEncodedPaths = new mutable.ArrayBuffer<string>();

  constructor() {
    super(Collection.of("scan", "encode", "metadata"));
  }

  protected override async processStep(
    step: "scan" | "encode" | "metadata",
    payload: VideoPayload & { encodedPath?: string },
    context: TaskContext,
  ): Promise<void> {
    this.visitedSteps.append(step);
    switch (step) {
      case "scan":
        context.spawnChild({
          queue: "child-q",
          payload: { videoId: payload.videoId },
        });
        return;
      case "encode":
        context.setPayload({
          ...payload,
          encodedPath: "/videos/42.mp4",
        });
        return;
      case "metadata":
        context.resolvedChildTask.foreach((childTask) => {
          this.metadataResolvedChildStatuses.append(childTask.status);
        });
        if (payload.encodedPath !== undefined) {
          this.metadataSeenEncodedPaths.append(payload.encodedPath);
        }
        context.submitResult({
          videoId: payload.videoId,
          encodedPath: payload.encodedPath,
        });
        return;
    }
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

describe("SequentialTask", () => {
  it("starts from the first configured step when workflow step is not set", async () => {
    const task = new RecordingSequentialTask();
    const context = createContext();
    const processStepSpy = jest.spyOn(task as any, "processStep");
    const payload = MultiStepPayload.forUserPayload({ videoId: 42 });

    await task.process(payload.toJson, context);

    expect(context.setPayload).toHaveBeenCalledWith({
      workflowPayload: { step: "scan" },
      userPayload: { videoId: 42 },
    });
    expect(processStepSpy).toHaveBeenCalledWith(
      "scan",
      { videoId: 42 },
      expect.objectContaining({
        taskId: context.taskId,
        currentAttempt: context.currentAttempt,
        maxAttempts: context.maxAttempts,
        resolvedChildTask: context.resolvedChildTask,
      }),
    );
  });

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
      expect.objectContaining({
        taskId: context.taskId,
        currentAttempt: context.currentAttempt,
        maxAttempts: context.maxAttempts,
        resolvedChildTask: context.resolvedChildTask,
      }),
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
        result: none,
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
      expect.objectContaining({
        taskId: context.taskId,
        currentAttempt: context.currentAttempt,
        maxAttempts: context.maxAttempts,
        resolvedChildTask: context.resolvedChildTask,
      }),
    );
  });

  it("treats context.setPayload in processStep as userPayload-only update", async () => {
    const task = new PayloadUpdatingSequentialTask();
    const context = createContext();

    await (task as any).childFinished(
      new MultiStepPayload(none, { step: "scan" }, { videoId: 42 }),
      {
        id: 10,
        parentId: 1,
        status: "finished",
        payload: undefined,
        result: none,
        error: undefined,
      } as TaskStateSnapshot,
      context,
    );

    expect(context.setPayload).toHaveBeenNthCalledWith(1, {
      workflowPayload: { step: "encode" },
      userPayload: { videoId: 42 },
    });
    expect(context.setPayload).toHaveBeenNthCalledWith(2, {
      workflowPayload: { step: "encode" },
      userPayload: {
        videoId: 42,
        encodedPath: "/videos/42.mp4",
      },
    });
  });

  it("auto-continues to the next step when a sequential step finishes without spawning a child", async () => {
    const task = new AutoContinuingSequentialTask();
    const context = createContext();

    await (task as any).childFinished(
      new MultiStepPayload(none, { step: "scan" }, { videoId: 42 }),
      {
        id: 10,
        parentId: 1,
        status: "finished",
        payload: undefined,
        result: none,
        error: undefined,
      } as TaskStateSnapshot,
      context,
    );

    expect(task.visitedSteps.toArray).toEqual(["encode", "metadata"]);
    expect(task.metadataResolvedChildStatuses.toArray).toEqual([]);
    expect(task.metadataSeenEncodedPaths.toArray).toEqual(["/videos/42.mp4"]);
    expect(context.setPayload).toHaveBeenNthCalledWith(1, {
      workflowPayload: { step: "encode" },
      userPayload: { videoId: 42 },
    });
    expect(context.setPayload).toHaveBeenNthCalledWith(2, {
      workflowPayload: { step: "encode" },
      userPayload: {
        videoId: 42,
        encodedPath: "/videos/42.mp4",
      },
    });
    expect(context.setPayload).toHaveBeenNthCalledWith(3, {
      workflowPayload: { step: "metadata" },
      userPayload: {
        videoId: 42,
        encodedPath: "/videos/42.mp4",
      },
    });
    expect(context.submitResult).toHaveBeenCalledWith({
      videoId: 42,
      encodedPath: "/videos/42.mp4",
    });
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
        result: none,
        error: undefined,
      } as TaskStateSnapshot,
      context,
    );

    expect(context.setPayload).not.toHaveBeenCalled();
    expect(processStepSpy).not.toHaveBeenCalled();
  });

  it("continues to the next step when child failure is allowed", async () => {
    const task = new TestSequentialTask();
    const context = createContext();
    const processStepSpy = jest.spyOn(task as any, "processStep");
    const payload = new MultiStepPayload(
      none,
      { step: "scan" },
      { videoId: 42 },
    );

    await (task as any).childFailed(
      payload,
      {
        id: 10,
        error: "boom",
      },
      context,
      new ActiveChildState(10, true),
    );

    expect(context.setPayload).toHaveBeenCalledWith({
      workflowPayload: { step: "encode" },
      userPayload: { videoId: 42 },
    });
    expect(processStepSpy).toHaveBeenCalledWith(
      "encode",
      { videoId: 42 },
      expect.objectContaining({
        taskId: context.taskId,
        currentAttempt: context.currentAttempt,
        maxAttempts: context.maxAttempts,
        resolvedChildTask: context.resolvedChildTask,
      }),
    );
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
          result: some({ metadata: true }),
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

    expect(task.seenResolvedChildStatuses.toArray).toEqual(["finished"]);
  });
});
