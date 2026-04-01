# Multi-step tasks

This library provides two base classes for multi-step workflows built on top of parent-child tasks:

- `MultiStepTask`
- `SequentialTask`

Both abstractions use the same payload envelope:

```ts
new MultiStepPayload(
    activeChildId,
    workflowPayload,
    userPayload
);
```

Where:

- `activeChildId` stores the currently running child task, if any
- `workflowPayload` stores orchestration state
- `userPayload` stores business data

## Common model

The engine supports one active child task at a time.

Workflow lifecycle:

1. Parent task starts.
2. Parent may call `context.spawnChild(...)`.
3. After `process(...)` returns, the engine creates the child task and moves the parent to `blocked`.
4. When the child reaches terminal state, the engine wakes the parent.
5. Parent is executed again and decides what to do next.

Important limitations:

- Only one active child is supported at a time.
- Periodic tasks must not use `spawnChild(...)` directly.
- Parent is woken only when child reaches terminal state.
- `workflowPayload` is persisted as plain JSON, so store serializable values only.

## MultiStepTask

`MultiStepTask` is the low-level orchestration abstraction.

Use it when:

- workflow decisions depend on child results
- you need custom transitions
- you need branching logic
- `SequentialTask` happy-path behavior is too limited

Key methods:

- `processNext(payload, context)` is called when there is no active child
- `childFinished(payload, childTask, context)` is called when child finished successfully
- `childFailed(payload, childTask)` is called when child reached terminal error

Default behavior:

- `childFinished(...)` calls `processNext(...)`
- `childFailed(...)` throws and fails the parent task

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
};

class EncodeUploadedVideoTask extends MultiStepTask<VideoPayload> {
    constructor(
        private readonly videosDao: VideosDao,
        private readonly transcoderBackend: TranscoderBackend
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
                    const metadata = await this.transcoderBackend.readMetadata(
                        payload.userPayload.encodedPath
                    );
                    await this.videosDao.saveMetadata(payload.userPayload.videoId, metadata);
                }
                await this.videosDao.updateStatus(payload.userPayload.videoId, "ready");
                context.setPayload(
                    payload.copy({
                        workflowPayload: {
                            ...payload.workflowPayload,
                            stage: "done"
                        }
                    }).toJson
                );
                break;

            case "encode":
            case "done":
                break;
        }
    }

    protected override async childFinished(
        payload: MultiStepPayload<VideoPayload>,
        childTask: TaskStateSnapshot,
        context: TaskContext
    ): Promise<void> {
        const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];

        switch (stage) {
            case "scan": {
                const nextPayload = payload.copy({
                    workflowPayload: {
                        ...payload.workflowPayload,
                        stage: "after-scan",
                        virusesFound: childTask.payload?.["virusesFound"] === true
                    }
                });
                context.setPayload(nextPayload.toJson);
                await this.processNext(nextPayload, context);
                break;
            }

            case "encode": {
                const encodedPath = String(childTask.payload?.["encodedPath"]);
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

            default:
                await this.processNext(payload, context);
                break;
        }
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

Key methods:

- constructor accepts `Collection<TStep>`
- `processStep(step, payload, context)` contains the business logic for the current step

Built-in behavior:

- after child success, `workflowPayload.step` is advanced automatically
- updated payload is persisted automatically
- next step is executed automatically
- terminal child failure fails the parent task

### Example: happy-path video processing

```ts
type VideoStep = "scan" | "encode" | "metadata";

type VideoPayload = {
    videoId: number;
    sourcePath: string;
    encodedPath?: string;
};

class ProcessUploadedVideoTask extends SequentialTask<VideoStep, VideoPayload> {
    constructor(
        private readonly videosDao: VideosDao
    ) {
        super(Collection.of("scan", "encode", "metadata"));
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
                if (payload.encodedPath) {
                    const metadata = await readVideoMetadata(payload.encodedPath);
                    await this.videosDao.updateMetadata(payload.videoId, metadata);
                }
                await this.videosDao.updateStatus(payload.videoId, "ready");
                break;
        }
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
