# Multi-step tasks

This library provides two base classes for multi-step workflows built on top of parent-child tasks:

- `MultiStepTask`
- `SequentialTask`

Both abstractions use the same payload envelope:

```ts
new MultiStepPayload(
    activeChild,
    workflowPayload,
    userPayload
);
```

Where:

- `activeChild` stores the currently running child task state, if any
- `workflowPayload` stores orchestration state
- `userPayload` stores business data

This is a required envelope, not just a recommendation. `MultiStepTask` and `SequentialTask`
must be scheduled with payloads produced from `MultiStepPayload` and must keep that shape across
all parent re-runs. Passing an arbitrary plain object as parent payload is not supported for
these abstractions.

Task `payload` remains the worker input and persisted runtime/orchestration state.
Final task output is stored separately in task `result`, which child snapshots expose as
`childTask.result`.

`activeChild` is persisted as JSON and currently supports:

```ts
{
    taskId: number;
    allowFailure?: boolean;
}
```

## Common model

The engine supports one active child task at a time.

Workflow lifecycle:

1. Parent task starts.
2. Parent may call `context.spawnChild(...)`.
3. After `process(...)` returns, the engine creates the child task, persists `activeChild` in the parent payload, and moves the parent to `blocked`.
4. When the child reaches terminal state, the engine wakes the parent.
5. Parent is executed again and decides what to do next.

Important limitations:

- Only one active child is supported at a time.
- Periodic tasks must not use `spawnChild(...)` directly.
- Parent is woken only when child reaches terminal state.
- `workflowPayload` is persisted as plain JSON, so store serializable values only.
- `allowFailure` is orchestration metadata for the parent. It does not change the child task status.

## MultiStepTask

`MultiStepTask` is the low-level orchestration abstraction.

Use it when:

- workflow decisions depend on child results
- you need custom transitions
- you need branching logic
- `SequentialTask` happy-path behavior is too limited

Key methods:

- `processNext(payload, context)` is called when there is no active child
- `childFinished(payload, childTask, context, activeChild)` is called when child finished successfully
- `childFailed(payload, childTask, context, activeChild)` is called when child reached terminal error

Default behavior:

- `childFinished(...)` calls `processNext(...)`
- `childFailed(...)` throws and fails the parent task
- `childTask.status` remains `error` even if the parent decides to continue workflow

`childFailed(...)` is called when the parent wakes up after the child has already reached terminal `error`.
If the child is retried and returns to `pending`, the parent remains `blocked` and `childFailed(...)`
is not called yet.

When a child is scheduled with:

```ts
context.spawnChild({
    queue: "child-queue",
    allowFailure: true,
    payload: { ... }
});
```

the runtime persists that policy into `payload.activeChild`, and the parent can inspect
`activeChild.allowFailure` inside `childFailed(...)`.

When a blocked parent wakes up after child completion, `TaskContext.resolvedChildTask`
contains the resolved child snapshot for the current continuation pass. This is useful
when the next workflow step needs to know whether the previous child finished successfully
or terminally failed. Read child output from `childTask.result`; `childTask.payload`
remains the child's persisted runtime state.

Child workers should call `context.submitResult({...})` when they want to expose final
output to the parent.

### Example: video processing with branching

```ts
type VideoWorkflowPayload = {
    stage: "scan" | "after-scan" | "encode" | "metadata" | "done";
    virusesFound?: boolean;
};

type VideoPayload = {
    videoId: number;
    sourcePath: string;
    encodedPath?: string;
    metadata?: Record<string, unknown>;
};

class EncodeUploadedVideoTask extends MultiStepTask<VideoPayload> {
    constructor(
        private readonly videosDao: VideosDao
    ) {
        super();
    }

    protected async processNext(
        payload: MultiStepPayload<VideoPayload>,
        context: TaskContext
    ): Promise<void> {
        const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];

        switch (stage) {
            case "scan":
                context.spawnChild({
                    queue: "scan-video-antivirus",
                    payload: {
                        videoId: payload.userPayload.videoId,
                        path: payload.userPayload.sourcePath
                    }
                });
                break;

            case "after-scan":
                if (payload.workflowPayload["virusesFound"] === true) {
                    await this.videosDao.updateStatus(payload.userPayload.videoId, "virus");
                    context.setPayload(
                        payload.copy({
                            workflowPayload: {
                                ...payload.workflowPayload,
                                stage: "done"
                            }
                        }).toJson
                    );
                } else {
                    const nextPayload = payload.copy({
                        workflowPayload: {
                            ...payload.workflowPayload,
                            stage: "encode"
                        }
                    });
                    context.setPayload(nextPayload.toJson);
                    context.spawnChild({
                        queue: "encode-video-file",
                        payload: {
                            videoId: nextPayload.userPayload.videoId,
                            path: nextPayload.userPayload.sourcePath
                        }
                    });
                }
                break;

            case "metadata":
                if (payload.userPayload.encodedPath) {
                    context.spawnChild({
                        queue: "read-video-metadata",
                        allowFailure: true,
                        payload: {
                            videoId: payload.userPayload.videoId,
                            encodedPath: payload.userPayload.encodedPath
                        }
                    });
                } else {
                    await this.videosDao.saveMetadata(payload.userPayload.videoId, {});
                    await this.videosDao.updateStatus(payload.userPayload.videoId, "ready");
                    context.setPayload(
                        payload.copy({
                            workflowPayload: {
                                ...payload.workflowPayload,
                                stage: "done"
                            }
                        }).toJson
                    );
                }
                break;

            case "encode":
            case "done":
                break;
        }
    }

    protected override async childFinished(
        payload: MultiStepPayload<VideoPayload>,
        childTask: TaskStateSnapshot,
        context: TaskContext,
        _activeChild: ActiveChildState
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
                            .getOrElseValue(false)
                    }
                });
                context.setPayload(nextPayload.toJson);
                await this.processNext(nextPayload, context);
                break;
            }

            case "encode": {
                const encodedPath = childTask.result
                    .map((r) => String(r["encodedPath"]))
                    .getOrElseValue("");
                await this.videosDao.updateEncodedPath(payload.userPayload.videoId, encodedPath);
                const nextPayload = payload.copy({
                    workflowPayload: {
                        ...payload.workflowPayload,
                        stage: "metadata"
                    },
                    userPayload: {
                        ...payload.userPayload,
                        encodedPath
                    }
                });
                context.setPayload(nextPayload.toJson);
                await this.processNext(nextPayload, context);
                break;
            }

            case "metadata": {
                await this.videosDao.saveMetadata(
                    payload.userPayload.videoId,
                    childTask.result.getOrElseValue({})
                );
                await this.videosDao.updateStatus(payload.userPayload.videoId, "ready");
                const nextPayload = payload.copy({
                    workflowPayload: {
                        ...payload.workflowPayload,
                        stage: "done"
                    }
                });
                context.setPayload(nextPayload.toJson);
                await this.processNext(nextPayload, context);
                break;
            }

            default:
                await this.processNext(payload, context);
                break;
        }
    }

    protected override async childFailed(
        payload: MultiStepPayload<VideoPayload>,
        childTask: TaskStateSnapshot,
        context: TaskContext,
        activeChild: ActiveChildState
    ): Promise<void> {
        const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];

        if (stage === "metadata" && activeChild.allowFailure) {
            await this.videosDao.saveMetadata(payload.userPayload.videoId, {});
            await this.videosDao.updateStatus(payload.userPayload.videoId, "ready");
            const nextPayload = payload.copy({
                workflowPayload: {
                    ...payload.workflowPayload,
                    stage: "done"
                }
            });
            context.setPayload(nextPayload.toJson);
            await this.processNext(nextPayload, context);
            return;
        }

        await super.childFailed(payload, childTask, context, activeChild);
    }
}
```

## SequentialTask

`SequentialTask` is a higher-level abstraction for happy-path sequential workflows.

Use it when:

- you have a fixed ordered list of steps
- each successful child completion should automatically move workflow to the next step
- workflow semantics are "finish all steps or fail"

Do not use it when:

- you need arbitrary branching transitions
- you need custom recovery paths
- the next state depends on complex child result handling

`SequentialTask` stores the current step in `workflowPayload.step`.
If `workflowPayload.step` is missing when the parent starts, the workflow begins from the
first configured step automatically and persists it into the payload.

Resolution model:

- the constructor step list is the canonical order of the workflow
- `workflowPayload.step` is the current cursor in that order
- if the cursor is missing on a fresh parent task, the first configured step is used
- once a child finishes successfully, the cursor advances to the next configured step
- if the current step is already the last configured step, no additional automatic transition happens

This means a sequential workflow can be created with an empty `workflowPayload`, and the first
parent execution will bootstrap `workflowPayload.step` from the configured step list.

Key methods:

- constructor accepts `Collection<TStep>`
- `processStep(step, payload, context)` contains the business logic for the current step

Built-in behavior:

- after child success, `workflowPayload.step` is advanced automatically
- updated payload is persisted automatically
- next step is executed automatically
- terminal child failure fails the parent task

### Example: video processing with optional metadata fallback

Notice the orchestration split in this example:

- `metadata` starts a child task with `allowFailure: true`
- `finalise` does not spawn any child tasks and reads metadata from resolved child `result`

```ts
type VideoStep = "scan" | "encode" | "metadata" | "finalise";

type VideoPayload = {
    videoId: number;
    sourcePath: string;
    encodedPath?: string;
};

class ProcessUploadedVideoTask extends SequentialTask<VideoStep, VideoPayload> {
    static readonly QUEUE_NAME = "process-uploaded-video";

    constructor(
        private readonly videosDao: VideosDao,
        private readonly tasks: TasksPoolsService
    ) {
        super(Collection.of("scan", "encode", "metadata", "finalise"));
    }

    async onApplicationBootstrap() {
        this.tasks.registerWorker(ProcessUploadedVideoTask.QUEUE_NAME, this);
    }

    protected async processStep(
        step: VideoStep,
        payload: VideoPayload,
        context: TaskContext
    ): Promise<void> {
        switch (step) {
            case "scan":
                context.spawnChild({
                    queue: "scan-video-antivirus",
                    payload: {
                        videoId: payload.videoId,
                        path: payload.sourcePath
                    }
                });
                break;

            case "encode":
                context.spawnChild({
                    queue: "encode-video-file",
                    payload: {
                        videoId: payload.videoId,
                        path: payload.sourcePath
                    }
                });
                break;

            case "metadata":
                if (!payload.encodedPath) {
                    await this.videosDao.updateMetadata(payload.videoId, {});
                    await this.videosDao.updateStatus(payload.videoId, "ready");
                    break;
                }
                context.spawnChild({
                    queue: "read-video-metadata",
                    allowFailure: true,
                    payload: {
                        videoId: payload.videoId,
                        encodedPath: payload.encodedPath
                    }
                });
                break;

            case "finalise":
                await this.videosDao.updateMetadata(
                    payload.videoId,
                    context.resolvedChildTask
                        .filter((t) => t.status === TaskStatus.finished)
                        .flatMap((t) => t.result)
                        .map((r) => r as Record<string, unknown>)
                        .getOrElseValue({})
                );
                await this.videosDao.updateStatus(payload.videoId, "ready");
                break;
        }
    }
}

await tasks.schedule({
    queue: ProcessUploadedVideoTask.QUEUE_NAME,
    payload: MultiStepPayload.forUserPayload({
        videoId: 42,
        sourcePath: "/uploads/video.mp4"
    }).toJson
});

// First parent execution resolves step = "scan" from the configured sequence
// and persists `workflowPayload.step = "scan"` automatically.
```

Child task example for `read-video-metadata`:

```ts
type ReadVideoMetadataPayload = {
    videoId: number;
    encodedPath: string;
};

class ReadVideoMetadataTask extends TasksWorker {
    constructor(
        private readonly mediaProbe: MediaProbeService
    ) {
        super();
    }

    override async process(
        payload: ReadVideoMetadataPayload,
        context: TaskContext
    ): Promise<void> {
        const metadata = await this.mediaProbe.readMetadata(payload.encodedPath);
        context.submitResult(metadata);
    }
}
```

## How to choose

Use `SequentialTask` if:

- steps are fixed and ordered
- happy-path orchestration is enough
- you want minimum boilerplate

Use `MultiStepTask` if:

- workflow is a real state machine
- child result changes the next transition
- you need explicit control over `workflowPayload`
- you want custom handling in `childFinished(...)` or `childFailed(...)`
