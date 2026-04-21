# NestJS `@Worker` method decorator

The library supports declarative worker registration for NestJS providers via the `@Worker(...)` method decorator.

This is an alternative to the classic approach where a class extends `TasksWorker` and calls `tasks.registerWorker(...)` in bootstrap hooks.

## What it does

When `TasksQueueModule` is initialized:

1. provider methods marked with `@Worker(...)` are discovered automatically
2. each method is wrapped into an internal `TasksWorker` adapter
3. the adapter is registered through `TasksPoolsService.registerWorker(...)`

This keeps runtime behavior identical to the regular queue engine while reducing manual wiring.

## Example

```ts
import { Injectable } from "@nestjs/common";
import { TaskContext, Worker } from "@penkov/tasks_queue";

type PayoutPayload = {
  payoutId: string;
};

type DownloadPayload = {
  documentId: string;
};

@Injectable()
export class FinanceWorkers {
  @Worker({ queue: "finance-payout" })
  async processPayout(
    payload: PayoutPayload,
    context: TaskContext,
  ): Promise<void> {
    await context.ping();
    context.submitResult({
      payoutId: payload.payoutId,
      status: "processed",
    });
  }

  @Worker({ queue: "finance-documents", pool: "documents" })
  async downloadDocument(
    payload: DownloadPayload,
    context: TaskContext,
  ): Promise<void> {
    context.submitResult({
      documentId: payload.documentId,
      downloaded: true,
    });
  }
}
```

## Decorator options

```ts
@Worker({
  queue: "queue-name", // required
  pool: "pool-name", // optional, defaults to "default"
})
```

- `queue`: queue name to bind this method to
- `pool`: target pool name from `TasksQueueModule` config

## Contract requirements

Decorated methods should follow the same process contract as regular workers:

- signature: `(payload: any, context: TaskContext)`
- return type: `Promise<void>`

If a method throws, retry/failure semantics are handled by the queue runtime exactly as with `TasksWorker.process(...)`.

## Constraints and behavior

- one queue can be registered only once
- duplicate queue registration still throws an error
- methods are auto-registered during module init, before queue pools start
- decorated providers must be part of the Nest application graph (declared in module providers)

## When to use which style

Use `@Worker(...)` when:

- you want concise declarative registration
- you prefer grouping related handlers in one provider

Use class-based `TasksWorker` when:

- you need worker lifecycle hooks: `starting(...)`, `completed(...)`, `failed(...)`
- you need explicit manual registration flow

Both styles can coexist in one application, but avoid mapping the same queue in both styles.
