# @penkov/tasks_queue

`@penkov/tasks_queue` is a PostgreSQL-backed task queue for Node.js applications.

It supports:

- one-time and delayed tasks
- retries with constant, linear, or exponential backoff
- priority-based fetching
- periodic scheduling with fixed rate, fixed delay, and cron
- parent-child workflows
- stalled task detection with heartbeat support
- queue management APIs for operational tooling

The library is designed to work especially well with NestJS, but its runtime model is framework-agnostic.

## Installation

```bash
npm install @penkov/tasks_queue
```

Install peer dependencies if they are not already present in your project:

```bash
npm install pg tslib application-metrics log4js scats cron-parser
```

For NestJS integration:

```bash
npm install @nestjs/common @nestjs/core @nestjs/swagger
```

Apply the schema from [migration.sql](migration.sql) to your PostgreSQL database before starting workers.

## Table of Contents

- [Core Concepts](#core-concepts)
- [Usage](#usage)
- [Integration with NestJS](#integration-with-nestjs)
- [Scheduling Tasks](#scheduling-tasks)
- [Spawning Child Subtasks](#spawning-child-subtasks)
- [Stalled Tasks and Heartbeat](#stalled-tasks-and-heartbeat)
- [Managing Tasks](#managing-tasks)
- [Operational Notes](#operational-notes)
- [Additional Documentation](#additional-documentation)

## Core Concepts

### Task lifecycle

Tasks move through these states:

- `pending`: waiting to be fetched by a worker
- `in_progress`: currently owned by a worker attempt
- `blocked`: waiting for a child task to finish
- `finished`: completed successfully
- `error`: failed terminally or timed out terminally

### Payload vs result

The library distinguishes between two different kinds of data:

- `payload`: task input and persisted runtime state
- `result`: final output produced by the worker

Use:

- `context.setPayload(...)` to checkpoint workflow state
- `context.submitResult(...)` to persist final output

This distinction matters for parent-child workflows: parent tasks read child output from `TaskStateSnapshot.result`, not from child `payload`.

Failure behavior matters here:

- successful completion persists submitted `result`
- terminal failure may also persist the submitted `result`
- retryable failure clears submitted `result` before the next attempt starts

This keeps retried attempts clean while still allowing terminal failures to retain partial output for inspection.

### Queues and pools

- A queue is a logical task type such as `send-email` or `generate-preview`.
- A pool is a worker group with its own concurrency and polling interval.
- Each queue is registered in exactly one pool.

This lets you isolate slow or expensive workloads from the default traffic.

### Timeouts and retries

Each task may define:

- `timeout`: maximum allowed time for a single processing attempt
- `retries`: maximum attempts
- `backoff`: base delay before retry
- `backoffType`: `constant`, `linear`, or `exponential`

If a task fails and still has attempts left, it is re-queued as `pending`. If not, it ends in `error`.

## Usage

This section shows the runtime contract once your application has access to `TasksPoolsService`.

The typical flow is:

1. register a worker for a queue
2. start the pools service
3. schedule tasks into that queue

### Create a worker

```ts
import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import {
  TaskContext,
  TasksPoolsService,
  TasksWorker,
} from "@penkov/tasks_queue";

@Injectable()
export class GeneratePreviewTaskWorker
  extends TasksWorker
  implements OnApplicationBootstrap
{
  static readonly QUEUE_NAME = "generate-preview";

  constructor(private readonly tasks: TasksPoolsService) {
    super();
  }

  async onApplicationBootstrap() {
    this.tasks.registerWorker(
      GeneratePreviewTaskWorker.QUEUE_NAME,
      this,
      "preview",
    );
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    const imageId = Number(payload["imageId"]);

    await context.ping();

    const previewUrl = `https://cdn.example.com/previews/${imageId}.jpg`;
    context.submitResult({ previewUrl });
  }
}
```

### Schedule a task

```ts
await this.tasks.schedule({
  queue: GeneratePreviewTaskWorker.QUEUE_NAME,
  payload: { imageId: 42 },
});
```

### Worker hooks

Override these hooks when you need lifecycle callbacks around processing:

- `starting(taskId, payload)`
- `completed(taskId, payload)`
- `failed(taskId, payload, finalStatus, error)`

Use them for logging, metrics, side effects, or alerting. The main business logic still belongs in `process(...)`.

Important callback semantics covered by integration tests:

- `completed(...)` runs only when the attempt really finishes successfully
- `failed(...)` receives `finalStatus = pending` when the task will retry
- `failed(...)` receives `finalStatus = error` on terminal failure
- if `process(...)` returns after the timeout window has already elapsed, `completed(...)` is skipped and `failed(...)` is invoked instead

## Integration with NestJS

`TasksQueueModule` is the main integration entry point.

It:

- creates queue services
- starts workers on application bootstrap
- stops them on application shutdown
- exports `TasksPoolsService` and `ManageTasksQueueService`

### Register the module

```ts
import pg from "pg";
import { Module } from "@nestjs/common";
import {
  DEFAULT_POOL,
  TasksQueueModule,
} from "@penkov/tasks_queue";

@Module({
  imports: [
    TasksQueueModule.forRootAsync({
      inject: [pg.Pool],
      useFactory: (db: pg.Pool) => ({
        db,
        runAuxiliaryWorker: true,
        pools: [
          {
            name: DEFAULT_POOL,
            loopInterval: 60_000,
            concurrency: 2,
          },
          {
            name: "preview",
            loopInterval: 60_000,
            concurrency: 5,
          },
        ],
      }),
    }),
  ],
})
export class AppModule {}
```

### Register workers in bootstrap-aware providers

Each worker should register itself into a queue during bootstrap:

```ts
async onApplicationBootstrap() {
  this.tasks.registerWorker(MyWorker.QUEUE_NAME, this, DEFAULT_POOL);
}
```

### When to use multiple pools

Create multiple pools when different workloads need different execution characteristics:

- a default pool for short tasks
- a dedicated pool for CPU-heavy or IO-heavy jobs
- a low-concurrency pool for rate-limited integrations

## Scheduling Tasks

The queue supports one-time, delayed, and periodic tasks.

### One-time task

```ts
await tasks.schedule({
  queue: "send-email",
  payload: { emailId: 123 },
});
```

### Delayed task

```ts
await tasks.schedule({
  queue: "send-email",
  startAfter: new Date(Date.now() + 5 * 60_000),
  payload: { emailId: 123 },
});
```

### Retry and timeout policy

```ts
import { BackoffType } from "@penkov/tasks_queue";

await tasks.schedule({
  queue: "send-email",
  payload: { emailId: 123 },
  timeout: 10 * 60_000,
  retries: 5,
  backoff: 60_000,
  backoffType: BackoffType.exponential,
  priority: 100,
});
```

### Fixed-rate periodic task

Use fixed rate when the schedule should stay aligned to the configured cadence regardless of how long the previous run took.

```ts
import { MissedRunStrategy } from "@penkov/tasks_queue";

await tasks.scheduleAtFixedRate({
  name: "refresh-cache",
  queue: "refresh-cache",
  period: 15 * 60_000,
  missedRunStrategy: MissedRunStrategy.skip_missed,
  payload: {},
});
```

### Fixed-delay periodic task

Use fixed delay when the next run should be scheduled after the current run finishes.

```ts
await tasks.scheduleAtFixedDelay({
  name: "sync-provider",
  queue: "sync-provider",
  period: 10 * 60_000,
  payload: {},
});
```

### Cron-based periodic task

Cron expressions currently run in UTC.

```ts
await tasks.scheduleAtCron({
  name: "nightly-report",
  queue: "nightly-report",
  cronExpression: "0 0 * * *",
  payload: {},
});
```

### Missed run strategy

Periodic tasks support two policies for downtime or missed windows:

- `skip_missed`: run once and continue from the next valid schedule
- `catch_up`: enqueue one run for each missed interval

Choose `catch_up` only when every missed execution is materially important.

### Periodic task timeout semantics

Periodic tasks do not always reschedule on completion.

If a periodic attempt overruns its `timeout`, the runtime uses normal timeout retry semantics first:

- the attempt is treated as failed
- retry `backoff` controls the next `startAfter`
- periodic rescheduling does not win over timeout retry

Only the currently owned periodic attempt may reschedule the row. A stale older attempt cannot shift the timer after a retry has already started.

## Spawning Child Subtasks

Parent-child orchestration is a first-class feature, but the detailed model is large enough that the full guide lives in [docs/multi-steps-tasks.md](docs/multi-steps-tasks.md).

The short version:

- a parent task can request one child via `context.spawnChild(...)`
- the child is created only after parent `process(...)` returns successfully
- the parent then moves to `blocked`
- when the child reaches terminal `finished` or terminal `error`, the parent wakes up again
- only one active child is supported at a time

### Simple child spawn

```ts
context.spawnChild({
  queue: "encode-video-file",
  payload: {
    videoId: 42,
    path: "/uploads/video.mp4",
  },
});
```

### Allow parent workflow to continue after child failure

```ts
context.spawnChild({
  queue: "read-video-metadata",
  allowFailure: true,
  payload: {
    videoId: 42,
    encodedPath: "/videos/42.mp4",
  },
});
```

### Recommended abstractions

Use:

- `MultiStepTask` for custom branching workflows
- `SequentialTask` for linear happy-path workflows
- `MultiStepPayload` as the required parent payload envelope

Detailed guide:

- [docs/multi-steps-tasks.md](docs/multi-steps-tasks.md)

## Stalled Tasks and Heartbeat

Long-running workers may need to refresh liveness while staying in `in_progress`.

Use `context.ping()` when a task:

- waits on slow external systems
- performs polling or streaming
- runs for a long time inside a single `process(...)`
- stays healthy without changing payload

### Example

```ts
override async process(payload: any, context: TaskContext): Promise<void> {
  await context.ping();

  const job = await this.backend.startExport(payload["reportId"]);

  while (!(await this.backend.isReady(job.id))) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await context.ping();
  }

  context.submitResult({
    reportId: payload["reportId"],
    exportId: job.id,
  });
}
```

Important behavior:

- stalled detection uses the latest of `started` and `last_heartbeat`
- heartbeat writes are throttled to at most once per minute
- if `ping()` happens after the timeout window already expired, the attempt times out
- if `process(...)` returns after the timeout window expired, that attempt also times out

Detailed guide:

- [docs/heartbeat.md](docs/heartbeat.md)

## Managing Tasks

`ManageTasksQueueService` is the operational API for admin panels, support tooling, and maintenance jobs.

It supports:

- fetch task by id
- list tasks with filters and pagination
- count or clear failed tasks
- update pending tasks
- update pending periodic schedules
- safely delete pending, finished, or failed tasks

### Typical use cases

- inspect a stuck task
- build an internal queue admin UI
- reschedule a pending task
- edit retry and timeout settings before execution
- clean up failed tasks after triage
- restart selected failed tasks
- expose queue count and wait/work latency stats

### Example

```ts
const task = await manageTasksQueueService.findById(taskId);

const page = await manageTasksQueueService.findByParameters({
  status: TaskStatus.error,
  queue: "send-email",
  offset: 0,
  limit: 50,
});

await manageTasksQueueService.updatePendingTask(taskId, {
  startAfter: new Date(Date.now() + 60_000),
  priority: 50,
  timeout: 15 * 60_000,
  payload: { emailId: 123, force: true },
  retries: 5,
  backoff: 60_000,
  backoffType: BackoffType.linear,
});
```

Deletion is intentionally conservative: active tasks are not deleted, and child tasks with unfinished ancestors are protected.

The management API also supports:

- restarting one failed task
- restarting all failed tasks in a selected queue
- queue-level counts grouped by status
- queue-level wait-time and work-time statistics

These methods are intended for admin tooling and operational dashboards.

## Auxiliary Worker

When `runAuxiliaryWorker` is enabled, the auxiliary worker runs periodic maintenance and metrics sync in the background.

Its maintenance pass covers:

- stalled task processing
- resetting eligible failed tasks back to `pending`
- clearing expired finished tasks

Its metrics sync registers queue/status gauges using sanitized metric names derived from queue names.

## Operational Notes

- Apply [migration.sql](migration.sql) before starting workers.
- `cronExpression` currently uses UTC evaluation.
- Long-running tasks should set `timeout` comfortably above the heartbeat persistence interval.
- `payload` is runtime state, not final output.
- retryable failure clears submitted `result`; terminal failure may retain it.
- Parent workflows should persist child-facing orchestration state through `MultiStepPayload`.
- Periodic tasks should not call `spawnChild(...)` directly.
- periodic timeout uses failure/retry semantics before normal periodic rescheduling.
- A queue must be registered in a pool before tasks can be processed immediately. Unregistered queues may still accumulate `pending` tasks.

## Additional Documentation

- [docs/multi-steps-tasks.md](docs/multi-steps-tasks.md): detailed guide for `MultiStepTask`, `SequentialTask`, child completion, failure handling, and payload shape
- [docs/heartbeat.md](docs/heartbeat.md): detailed guide for heartbeat behavior and stalled detection
