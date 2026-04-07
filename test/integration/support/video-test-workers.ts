import { Collection } from "scats";
import { SequentialTask } from "../../../src/sequential-task.js";
import { TaskContext, TaskFailed } from "../../../src/tasks-model.js";
import { TimeUtils } from "../../../src/time-utils.js";
import { TasksWorker } from "../../../src/tasks-worker.js";

export const VIDEO_PARENT_QUEUE = "video-parent";
export const VIDEO_UPLOAD_QUEUE = "video-upload";
export const VIDEO_METADATA_QUEUE = "video-metadata";
export const VIDEO_PARENT_FAILURE_QUEUE = "video-parent-failure";
export const VIDEO_FAILING_UPLOAD_QUEUE = "video-failing-upload";
export const VIDEO_PARENT_ALLOW_FAILURE_QUEUE = "video-parent-allow-failure";
export const VIDEO_PARENT_SECOND_CHILD_FAILURE_QUEUE =
  "video-parent-second-child-failure";
export const VIDEO_PARENT_SECOND_CHILD_ALLOW_FAILURE_QUEUE =
  "video-parent-second-child-allow-failure";
export const VIDEO_PARENT_STALLED_CHILD_QUEUE = "video-parent-stalled-child";
export const VIDEO_PARENT_POST_CHILD_CRASH_QUEUE =
  "video-parent-post-child-crash";
export const VIDEO_PARENT_TASK_FAILED_QUEUE = "video-parent-task-failed";
export const VIDEO_TASK_FAILED_UPLOAD_QUEUE = "video-task-failed-upload";
export const VIDEO_PARENT_LOCAL_STEP_QUEUE = "video-parent-local-step";

/**
 * User payload shape used by the video workflow test workers.
 *
 * In integration tests this object represents the business state that should survive
 * sequential parent wake-ups across child tasks.
 */
export type VideoWorkflowPayload = {
  videoId: string;
  uploadResult?: {
    videoId: string;
    path: string;
  };
  metadataResult?: {
    path: string;
    durationSec: number;
    width: number;
    height: number;
  };
};

/**
 * Happy-path sequential parent workflow used by integration tests around parent-child orchestration.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_QUEUE}
 * - also register {@link UploadVideoWorker} under {@link VIDEO_UPLOAD_QUEUE}
 * - also register {@link ReadVideoMetadataWorker} under {@link VIDEO_METADATA_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns upload child
 * - second parent run consumes upload child result and spawns metadata child
 * - final parent run aggregates both child results into the parent result
 *
 * What this worker is meant to verify:
 * - `SequentialTask` automatically owns `workflowPayload.step`
 * - `context.setPayload(...)` inside `processStep(...)` accepts user payload only
 * - child `result` values are passed through parent state between sequential steps
 */
export class SequentialVideoWorker extends SequentialTask<
  "upload" | "metadata" | "aggregate",
  VideoWorkflowPayload
> {
  constructor() {
    super(Collection.of("upload", "metadata", "aggregate"));
  }

  protected override async processStep(
    step: "upload" | "metadata" | "aggregate",
    payload: VideoWorkflowPayload,
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
        });
        return;
      case "metadata": {
        const uploadResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as VideoWorkflowPayload["uploadResult"];
        context.setPayload({
          ...payload,
          uploadResult,
        });
        context.spawnChild({
          queue: VIDEO_METADATA_QUEUE,
          payload: {
            path:
              uploadResult !== undefined &&
              uploadResult !== null &&
              "path" in uploadResult
                ? String(uploadResult.path)
                : "",
          },
        });
        return;
      }
      case "aggregate": {
        const metadataResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as VideoWorkflowPayload["metadataResult"];
        context.setPayload({
          ...payload,
          metadataResult,
        });
        context.submitResult({
          videoId: payload.videoId,
          upload: payload.uploadResult,
          metadata: metadataResult,
        });
        return;
      }
    }
  }
}

/**
 * Happy-path sequential workflow with an intermediate local step that does not
 * spawn a child.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_LOCAL_STEP_QUEUE}
 * - also register {@link UploadVideoWorker} under {@link VIDEO_UPLOAD_QUEUE}
 * - also register {@link ReadVideoMetadataWorker} under {@link VIDEO_METADATA_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns upload child
 * - second parent run resumes after upload, stores upload result in a local-only step,
 *   then immediately advances to metadata and spawns metadata child in the same parent execution
 * - final parent run aggregates metadata into final output
 *
 * This worker exists specifically to verify the `SequentialTask` nuance where a
 * step that does not call `context.spawnChild(...)` auto-continues to the next
 * configured step without finishing the parent early.
 */
export class SequentialVideoWithLocalStepWorker extends SequentialTask<
  "upload" | "prepare-metadata" | "metadata" | "aggregate",
  VideoWorkflowPayload
> {
  constructor() {
    super(
      Collection.of("upload", "prepare-metadata", "metadata", "aggregate"),
    );
  }

  protected override async processStep(
    step: "upload" | "prepare-metadata" | "metadata" | "aggregate",
    payload: VideoWorkflowPayload,
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
        });
        return;
      case "prepare-metadata": {
        const uploadResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as VideoWorkflowPayload["uploadResult"];
        context.setPayload({
          ...payload,
          uploadResult,
        });
        return;
      }
      case "metadata":
        context.spawnChild({
          queue: VIDEO_METADATA_QUEUE,
          payload: {
            path:
              payload.uploadResult !== undefined &&
              payload.uploadResult !== null &&
              "path" in payload.uploadResult
                ? String(payload.uploadResult.path)
                : "",
          },
        });
        return;
      case "aggregate": {
        const metadataResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as VideoWorkflowPayload["metadataResult"];
        context.setPayload({
          ...payload,
          metadataResult,
        });
        context.submitResult({
          videoId: payload.videoId,
          upload: payload.uploadResult,
          metadata: metadataResult,
        });
        return;
      }
    }
  }
}

/**
 * Retry-and-fail parent workflow used by integration tests for child failure semantics.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_FAILURE_QUEUE}
 * - register a controllable child worker under {@link VIDEO_FAILING_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns a child with `retries=2` and minute backoff
 * - fail the child once and assert parent is still `blocked`
 * - fail the child terminally and assert parent wakes to `pending`
 * - run parent again and assert default `SequentialTask` behavior turns parent into `error`
 *
 * This worker intentionally does not implement custom child error recovery. It exists to verify
 * the default contract: intermediate child retries must not wake parent, but terminal child error
 * must eventually fail parent.
 */
export class SequentialFailingVideoWorker extends SequentialTask<
  "upload",
  { videoId: string }
> {
  constructor() {
    super(Collection.of("upload"));
  }

  protected override async processStep(
    step: "upload",
    payload: { videoId: string },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_FAILING_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
          retries: 2,
          backoff: TimeUtils.minute,
        });
        return;
    }
  }
}

/**
 * Allow-failure parent workflow used by integration tests for graceful continuation after
 * terminal child error.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_ALLOW_FAILURE_QUEUE}
 * - register a controllable child worker under {@link VIDEO_FAILING_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns a child with `allowFailure=true`
 * - child may retry while parent stays `blocked`
 * - once child reaches terminal `error`, parent must wake and continue to the next step instead
 *   of failing
 * - final parent run should complete successfully and may inspect `context.resolvedChildTask` to
 *   capture child status and error details in final result
 *
 * This worker is the positive counterpart to {@link SequentialFailingVideoWorker}: it verifies
 * that `SequentialTask` can continue after terminal child error when orchestration explicitly
 * allows that failure.
 */
export class SequentialAllowFailureVideoWorker extends SequentialTask<
  "upload" | "aggregate",
  {
    videoId: string;
    childStatus?: string;
    childError?: string;
  }
> {
  constructor() {
    super(Collection.of("upload", "aggregate"));
  }

  protected override async processStep(
    step: "upload" | "aggregate",
    payload: {
      videoId: string;
      childStatus?: string;
      childError?: string;
    },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_FAILING_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
          retries: 2,
          backoff: TimeUtils.minute,
          allowFailure: true,
        });
        return;
      case "aggregate": {
        const childStatus = context.resolvedChildTask.map(
          (task) => task.status,
        ).orUndefined;
        const childError = context.resolvedChildTask.map(
          (task) => task.error,
        ).orUndefined;
        context.setPayload({
          ...payload,
          childStatus,
          childError,
        });
        context.submitResult({
          videoId: payload.videoId,
          childStatus,
          childError,
        });
        return;
      }
    }
  }
}

/**
 * Parent workflow used by integration tests where the first child succeeds and the second child
 * is the one that retries and eventually fails.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_SECOND_CHILD_FAILURE_QUEUE}
 * - register {@link UploadVideoWorker} under {@link VIDEO_UPLOAD_QUEUE}
 * - register a controllable worker under {@link VIDEO_FAILING_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns successful upload child
 * - second parent run stores upload result and spawns retryable failing metadata child
 * - on intermediate metadata failure parent must remain `blocked`
 * - on terminal metadata error parent must wake and fail with the default SequentialTask behavior
 *
 * This worker verifies that parent-child retry semantics are consistent not only for the first
 * child in the sequence, but also after earlier successful steps have already updated parent state.
 */
export class SequentialSecondChildFailingVideoWorker extends SequentialTask<
  "upload" | "metadata",
  {
    videoId: string;
    uploadResult?: {
      videoId: string;
      path: string;
    };
  }
> {
  constructor() {
    super(Collection.of("upload", "metadata"));
  }

  protected override async processStep(
    step: "upload" | "metadata",
    payload: {
      videoId: string;
      uploadResult?: {
        videoId: string;
        path: string;
      };
    },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
        });
        return;
      case "metadata": {
        const uploadResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as
          | {
              videoId: string;
              path: string;
            }
          | undefined;
        context.setPayload({
          ...payload,
          uploadResult,
        });
        context.spawnChild({
          queue: VIDEO_FAILING_UPLOAD_QUEUE,
          payload: {
            path:
              uploadResult !== undefined &&
              uploadResult !== null &&
              "path" in uploadResult
                ? String(uploadResult.path)
                : "",
          },
          retries: 2,
          backoff: TimeUtils.minute,
        });
        return;
      }
    }
  }
}

/**
 * Parent workflow used by integration tests where the first child succeeds and the second child
 * is allowed to fail terminally without failing the parent.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_SECOND_CHILD_ALLOW_FAILURE_QUEUE}
 * - register {@link UploadVideoWorker} under {@link VIDEO_UPLOAD_QUEUE}
 * - register a controllable worker under {@link VIDEO_FAILING_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns successful upload child
 * - second parent run stores upload result and spawns retryable second child with `allowFailure`
 * - intermediate second-child failures must keep parent `blocked`
 * - terminal second-child error must wake parent and allow it to finish the next step successfully
 */
export class SequentialSecondChildAllowFailureVideoWorker extends SequentialTask<
  "upload" | "metadata" | "aggregate",
  {
    videoId: string;
    uploadResult?: {
      videoId: string;
      path: string;
    };
    childStatus?: string;
    childError?: string;
  }
> {
  constructor() {
    super(Collection.of("upload", "metadata", "aggregate"));
  }

  protected override async processStep(
    step: "upload" | "metadata" | "aggregate",
    payload: {
      videoId: string;
      uploadResult?: {
        videoId: string;
        path: string;
      };
      childStatus?: string;
      childError?: string;
    },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
        });
        return;
      case "metadata": {
        const uploadResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as
          | {
              videoId: string;
              path: string;
            }
          | undefined;
        context.setPayload({
          ...payload,
          uploadResult,
        });
        context.spawnChild({
          queue: VIDEO_FAILING_UPLOAD_QUEUE,
          payload: {
            path:
              uploadResult !== undefined &&
              uploadResult !== null &&
              "path" in uploadResult
                ? String(uploadResult.path)
                : "",
          },
          retries: 2,
          backoff: TimeUtils.minute,
          allowFailure: true,
        });
        return;
      }
      case "aggregate": {
        const childStatus = context.resolvedChildTask.map(
          (task) => task.status,
        ).orUndefined;
        const childError = context.resolvedChildTask.map(
          (task) => task.error,
        ).orUndefined;
        context.setPayload({
          ...payload,
          childStatus,
          childError,
        });
        context.submitResult({
          videoId: payload.videoId,
          upload: payload.uploadResult,
          childStatus,
          childError,
        });
        return;
      }
    }
  }
}

/**
 * Parent workflow used by integration tests around child timeout handling.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_STALLED_CHILD_QUEUE}
 * - register a hanging controllable worker under {@link VIDEO_FAILING_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns a child with low timeout and retries
 * - tests call `failStalled(...)` to transition child through timeout retry and terminal timeout
 * - parent must remain `blocked` on retryable timeout and wake only after terminal timeout
 *
 * This worker verifies parent-child semantics for auxiliary timeout detection, not just explicit
 * runtime exceptions thrown by child workers.
 */
export class SequentialStalledChildVideoWorker extends SequentialTask<
  "upload",
  { videoId: string }
> {
  constructor() {
    super(Collection.of("upload"));
  }

  protected override async processStep(
    step: "upload",
    payload: { videoId: string },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_FAILING_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
          retries: 2,
          backoff: TimeUtils.minute,
          timeout: TimeUtils.second,
        });
        return;
    }
  }
}

/**
 * Parent workflow used by integration tests where a child succeeds but the parent itself crashes
 * immediately after wake-up while handling the next step.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_POST_CHILD_CRASH_QUEUE}
 * - register {@link UploadVideoWorker} under {@link VIDEO_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns successful upload child
 * - second run executes the child and wakes parent back to pending
 * - third run resumes parent, advances to the next step, and throws from the parent step handler
 *
 * This worker verifies that parent-side failures after wake-up are tracked as parent errors rather
 * than child errors, and that the parent attempt counter is spent only on the resumed parent pass.
 */
export class SequentialParentCrashAfterWakeWorker extends SequentialTask<
  "upload" | "aggregate",
  {
    videoId: string;
    uploadResult?: {
      videoId: string;
      path: string;
    };
  }
> {
  constructor() {
    super(Collection.of("upload", "aggregate"));
  }

  protected override async processStep(
    step: "upload" | "aggregate",
    payload: {
      videoId: string;
      uploadResult?: {
        videoId: string;
        path: string;
      };
    },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
        });
        return;
      case "aggregate": {
        const uploadResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as
          | {
              videoId: string;
              path: string;
            }
          | undefined;
        context.setPayload({
          ...payload,
          uploadResult,
        });
        throw new Error("Parent post-child crash");
      }
    }
  }
}

/**
 * Parent workflow used by integration tests for child `TaskFailed` retries with payload
 * replacement.
 *
 * Usage in tests:
 * - register this worker under {@link VIDEO_PARENT_TASK_FAILED_QUEUE}
 * - register {@link TaskFailedUploadWorker} under {@link VIDEO_TASK_FAILED_UPLOAD_QUEUE}
 * - schedule parent task with `MultiStepPayload.forUserPayload({ videoId }).toJson`
 * - first parent run spawns retryable child
 * - first child run throws `TaskFailed` and replaces its own payload for the next attempt
 * - parent must stay `blocked` while child is `pending`
 * - retried child succeeds using the replaced payload
 * - resumed parent aggregates child result and finishes successfully
 *
 * This worker verifies end-to-end compatibility between `TaskFailed` payload replacement and
 * parent-child orchestration.
 */
export class SequentialTaskFailedVideoWorker extends SequentialTask<
  "upload" | "aggregate",
  {
    videoId: string;
    childResult?: {
      videoId: string;
      path: string;
      retried: boolean;
    };
  }
> {
  constructor() {
    super(Collection.of("upload", "aggregate"));
  }

  protected override async processStep(
    step: "upload" | "aggregate",
    payload: {
      videoId: string;
      childResult?: {
        videoId: string;
        path: string;
        retried: boolean;
      };
    },
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: VIDEO_TASK_FAILED_UPLOAD_QUEUE,
          payload: {
            videoId: payload.videoId,
          },
          retries: 2,
          backoff: TimeUtils.minute,
        });
        return;
      case "aggregate": {
        const childResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as
          | {
              videoId: string;
              path: string;
              retried: boolean;
            }
          | undefined;
        context.setPayload({
          ...payload,
          childResult,
        });
        context.submitResult({
          videoId: payload.videoId,
          child: childResult,
        });
        return;
      }
    }
  }
}

/**
 * Child worker that intentionally uses `TaskFailed` once before succeeding on the retry.
 *
 * Usage in tests:
 * - register under {@link VIDEO_TASK_FAILED_UPLOAD_QUEUE}
 * - pass initial child payload `{ videoId }`
 * - first execution throws `TaskFailed(...)` with a replacement payload that includes retry data
 * - second execution reads the replaced payload and emits a final successful upload result
 *
 * This worker gives integration tests a deterministic way to verify that retry payload
 * replacement survives inside parent-child workflows and is visible on the subsequent child
 * attempt.
 */
export class TaskFailedUploadWorker extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    if (payload.retryPath === undefined) {
      throw new TaskFailed("Upload retry requested", {
        ...payload,
        retryPath: `/videos/${payload.videoId}.retry.mp4`,
      });
    }
    context.submitResult({
      videoId: payload.videoId,
      path: payload.retryPath,
      retried: true,
    });
  }
}

/**
 * Deterministic upload child worker for integration tests.
 *
 * Usage in tests:
 * - register under {@link VIDEO_UPLOAD_QUEUE}
 * - parent should pass `{ videoId }` as child payload
 * - this worker immediately submits a synthetic upload result containing final path
 *
 * This worker is intentionally side-effect free: it acts as a stable fixture for parent-child
 * result propagation tests and avoids any need for external services or mock coordination.
 */
export class UploadVideoWorker extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    context.submitResult({
      videoId: payload.videoId,
      path: `/videos/${payload.videoId}.mp4`,
    });
  }
}

/**
 * Deterministic metadata child worker for integration tests.
 *
 * Usage in tests:
 * - register under {@link VIDEO_METADATA_QUEUE}
 * - parent should pass `{ path }` obtained from upload child result
 * - this worker immediately submits fixed video metadata for that path
 *
 * This worker complements {@link UploadVideoWorker} in happy-path sequential workflow tests where
 * parent must aggregate multiple child `result` payloads into final task output.
 */
export class ReadVideoMetadataWorker extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    context.submitResult({
      path: payload.path,
      durationSec: 120,
      width: 1920,
      height: 1080,
    });
  }
}
