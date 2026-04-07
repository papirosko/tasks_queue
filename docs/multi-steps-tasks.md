# Multi-step tasks

This library provides two base classes for stateful parent-child workflows:

- `MultiStepTask`
- `SequentialTask`

Both abstractions are built on top of the same runtime contract:

- a parent task may request exactly one child via `context.spawnChild(...)`
- the parent is then moved to `blocked`
- the child runs independently with its own retries, timeout, payload, and result
- when the child reaches terminal `finished` or terminal `error`, the parent is moved back to `pending`
- the parent runs again and decides what to do next

## Required payload shape

`MultiStepTask` and `SequentialTask` require payloads produced from `MultiStepPayload`.

```ts
new MultiStepPayload(
  activeChild,
  workflowPayload,
  userPayload,
);
```

Where:

- `activeChild` stores metadata about the currently active child
- `workflowPayload` stores orchestration state
- `userPayload` stores domain data

This is a strict contract, not just a convention. These abstractions should not be scheduled with arbitrary plain objects.

Task data is split into two channels:

- `payload`: worker input and persisted runtime state
- `result`: final output submitted via `context.submitResult(...)`

Parent workflows should read child output from `childTask.result`, not from `childTask.payload`.

`activeChild` is persisted as JSON and currently has this shape:

```ts
{
  taskId: number;
  allowFailure?: boolean;
}
```

## Common lifecycle

High-level flow:

1. Parent runs in `in_progress`.
2. Parent may call `context.spawnChild(...)`.
3. After parent `process(...)` returns successfully, the runtime atomically:
   - moves the parent to `blocked`
   - creates the child task
   - persists `activeChild` into the parent payload
4. Child runs with normal queue semantics.
5. When the child reaches terminal `finished` or terminal `error`, the parent is moved back to `pending`.
6. Parent runs again and continues the workflow.

Important guarantees:

- Parent blocking and child creation happen in one transaction.
- The system does not expose a blocked parent without a child, or a child without its parent being blocked.
- Only one active child is supported at a time.
- Parent wake-up happens only on terminal child completion, not on intermediate retries.
- Parent `payload.activeChild` is cleared before `childFinished(...)` or `childFailed(...)` is called.

Important limitations:

- Periodic tasks must not use `spawnChild(...)` directly.
- `workflowPayload` and `userPayload` must remain JSON-serializable.
- `allowFailure` affects only parent orchestration. The child itself still ends in `error`.

## Attempt semantics

Parent and child attempts are independent.

Confirmed by integration tests:

- When a parent blocks on a child, the parent does not spend its own attempt budget for that transition.
- While the child is retrying, the parent remains `blocked` with the same attempt counter.
- When the parent is resumed after child completion, that resumed parent run is a new parent attempt and may succeed or fail independently.

This means a child may consume multiple attempts without affecting parent attempts, and a resumed parent may still fail even after a successful child.

## `MultiStepTask`

`MultiStepTask` is the low-level abstraction for custom orchestration.

Use it when:

- workflow decisions depend on child results
- you need branching logic
- you need custom transitions after child success or failure
- `SequentialTask` happy-path semantics are too restrictive

Key hooks:

- `processNext(payload, context)`: called when there is no active child
- `childFinished(payload, childTask, context, activeChild)`: called after terminal child success
- `childFailed(payload, childTask, context, activeChild)`: called after terminal child failure

Default behavior:

- `childFinished(...)` calls `processNext(...)`
- `childFailed(...)` throws and fails the parent

`TaskContext.resolvedChildTask` is populated during the resumed parent pass after child completion. It contains the child snapshot that woke the parent.

This is the recommended way to read:

- child final `status`
- child final `error`
- child final `result`

### `allowFailure`

When a child is spawned with:

```ts
context.spawnChild({
  queue: "child-queue",
  allowFailure: true,
  payload: { ... },
});
```

the runtime persists that flag into `payload.activeChild`. Later, inside `childFailed(...)`, the parent can inspect `activeChild.allowFailure` and decide whether to continue or fail.

The child still keeps `status = error`. `allowFailure` does not rewrite child state.

## `SequentialTask`

`SequentialTask` is a happy-path helper built on top of `MultiStepTask`.

Use it when:

- your workflow is linear
- steps have a fixed order
- the default behavior should be "run next step or fail"

Step resolution rules:

- the current step is read from `workflowPayload.step`
- if missing, the first configured step is used automatically
- that resolved first step is persisted before `processStep(...)` runs

Inside `processStep(...)`, `context.setPayload(...)` accepts only the next `userPayload`. `SequentialTask` wraps it back into the full `MultiStepPayload` envelope.

Default behavior:

- after child success, move to the next configured step and run it immediately
- after child failure, fail the parent
- if the failed child had `allowFailure=true`, continue to the next configured step instead

## Result propagation

Integration tests cover the normal pattern:

1. Parent spawns child A.
2. Child A submits `result`.
3. Parent resumes, reads `context.resolvedChildTask`, stores derived state into parent payload, and spawns child B.
4. Child B submits `result`.
5. Parent resumes again and aggregates final output.

Typical code:

```ts
const uploadResult = context.resolvedChildTask.flatMap(
  (task) => task.result,
).orUndefined;

context.setPayload({
  ...payload,
  uploadResult,
});
```

Use `context.submitResult(...)` in the parent only for the final parent output. Use `context.setPayload(...)` for workflow state that must survive across re-runs.

## Retry and timeout behavior

Child tasks keep their normal queue semantics while the parent is blocked.

Covered by integration tests:

- If a child fails but still has retries left, the child returns to `pending` and the parent stays `blocked`.
- If a child times out but still has retries left, the child returns to `pending` and the parent stays `blocked`.
- The parent wakes only after the child reaches terminal `finished` or terminal `error`.
- On terminal child timeout, the parent wakes exactly the same way as on terminal child exception.

The parent does not poll child state actively. Wake-up is driven by child terminal transitions.

## `TaskFailed` inside child workflows

Child workers may throw `TaskFailed(message, payload)` to replace their own payload for the next retry.

This is fully compatible with parent-child orchestration.

Covered by integration tests:

- the parent remains `blocked` while the child is retried with replacement payload
- the replacement payload is visible to the child on the next attempt
- if the child later succeeds, the resumed parent sees the child final `result` as usual

`TaskFailed` changes child retry payload. It does not wake the parent early.

## Race conditions and stale attempts

The runtime defends against stale worker attempts acting on rows they no longer own.

Covered by integration tests:

- If a parent attempt stalls, the task is retried, and the old parent attempt later returns, that stale attempt must not block the current parent row or create a child.
- If a child attempt stalls, the child is retried, and the old child attempt later returns, that stale attempt must not wake the blocked parent.
- Ownership checks are tied to the persisted `started` timestamp of the current attempt.

Practical consequence:

- only the current attempt may heartbeat, finish, fail, block, or wake workflow state
- stale local code may still finish in memory, but it cannot mutate queue state if ownership has already moved to another attempt

This is especially important for long-running workers and timeout-driven retries.

## Invalid active-child state

Parent resume assumes that `payload.activeChild` points to a real child task which is already terminal.

Covered by integration tests:

- if `activeChild.taskId` points to a missing task, the parent fails explicitly
- if `activeChild.taskId` points to an existing but non-terminal task during a resumed pass, the parent fails with an inconsistency error

These failures are intentional. They surface corrupted orchestration state instead of silently guessing how to recover.

## Parent wake-up failures

A child may finish successfully and wake the parent, but the resumed parent run can still fail.

Covered by integration tests:

- child finishes successfully
- parent wakes and starts next step
- parent throws during that resumed pass
- the failure is recorded as a parent failure, not a child failure

This is expected: parent continuation is its own execution pass with its own attempt accounting.

## Example: branching `MultiStepTask`

```ts
type VideoWorkflowPayload = {
  stage: "scan" | "after-scan" | "encode" | "metadata" | "done";
  virusesFound?: boolean;
};

type VideoPayload = {
  videoId: number;
  sourcePath: string;
  encodedPath?: string;
};

class EncodeUploadedVideoTask extends MultiStepTask<VideoPayload> {
  protected async processNext(
    payload: MultiStepPayload<VideoPayload>,
    context: TaskContext,
  ): Promise<void> {
    const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];

    switch (stage) {
      case "scan":
        context.spawnChild({
          queue: "scan-video-antivirus",
          payload: {
            videoId: payload.userPayload.videoId,
            path: payload.userPayload.sourcePath,
          },
        });
        return;

      case "after-scan":
        if (payload.workflowPayload["virusesFound"] === true) {
          context.setPayload(
            payload.copy({
              workflowPayload: {
                ...payload.workflowPayload,
                stage: "done",
              },
            }).toJson,
          );
          return;
        }

        const nextPayload = payload.copy({
          workflowPayload: {
            ...payload.workflowPayload,
            stage: "encode",
          },
        });
        context.setPayload(nextPayload.toJson);
        context.spawnChild({
          queue: "encode-video-file",
          payload: {
            videoId: nextPayload.userPayload.videoId,
            path: nextPayload.userPayload.sourcePath,
          },
        });
        return;

      case "metadata":
        context.spawnChild({
          queue: "read-video-metadata",
          allowFailure: true,
          payload: {
            videoId: payload.userPayload.videoId,
            encodedPath: payload.userPayload.encodedPath,
          },
        });
        return;

      case "encode":
      case "done":
        return;
    }
  }

  protected override async childFinished(
    payload: MultiStepPayload<VideoPayload>,
    childTask: TaskStateSnapshot,
    context: TaskContext,
    _activeChild: ActiveChildState,
  ): Promise<void> {
    const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];

    switch (stage) {
      case "scan": {
        const nextPayload = payload.copy({
          workflowPayload: {
            ...payload.workflowPayload,
            stage: "after-scan",
            virusesFound: childTask.result
              .map((r) => r["virusesFound"] === true)
              .getOrElseValue(false),
          },
        });
        context.setPayload(nextPayload.toJson);
        await this.processNext(nextPayload, context);
        return;
      }

      case "encode": {
        const encodedPath = childTask.result
          .map((r) => String(r["encodedPath"]))
          .getOrElseValue("");
        const nextPayload = payload.copy({
          workflowPayload: {
            ...payload.workflowPayload,
            stage: "metadata",
          },
          userPayload: {
            ...payload.userPayload,
            encodedPath,
          },
        });
        context.setPayload(nextPayload.toJson);
        await this.processNext(nextPayload, context);
        return;
      }

      case "metadata":
      case "after-scan":
      case "done":
        await this.processNext(payload, context);
        return;
    }
  }
}
```

## Example: happy-path `SequentialTask`

```ts
type VideoStep = "upload" | "metadata" | "aggregate";

type VideoPayload = {
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

class SequentialVideoWorker extends SequentialTask<VideoStep, VideoPayload> {
  constructor() {
    super(Collection.of("upload", "metadata", "aggregate"));
  }

  protected override async processStep(
    step: VideoStep,
    payload: VideoPayload,
    context: TaskContext,
  ): Promise<void> {
    switch (step) {
      case "upload":
        context.spawnChild({
          queue: "video-upload",
          payload: { videoId: payload.videoId },
        });
        return;

      case "metadata": {
        const uploadResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as VideoPayload["uploadResult"];

        context.setPayload({
          ...payload,
          uploadResult,
        });

        context.spawnChild({
          queue: "video-metadata",
          payload: { path: uploadResult?.path },
        });
        return;
      }

      case "aggregate": {
        const metadataResult = context.resolvedChildTask.flatMap(
          (task) => task.result,
        ).orUndefined as VideoPayload["metadataResult"];

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
```
