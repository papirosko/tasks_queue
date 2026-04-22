# NestJS `@ScheduledTask` method decorator

The library supports declarative periodic workers in NestJS providers through
`@ScheduledTask(...)`.

- `@ScheduledTask(...)` registers queue handlers in runtime pools
- `@ScheduledTask(...)` also provisions periodic rows in `tasks_queue`

## Example

```ts
import { Injectable } from "@nestjs/common";
import {
  ScheduledTask,
  TaskContext,
} from "@penkov/tasks_queue";

@Injectable()
export class FinanceWorkers {
  @ScheduledTask({
    name: "finance-sync-cron",
    queue: "finance-sync",
    pool: "finance",
    cron: "0 */5 * * * *",
    replaceExisting: true,
    payload: { source: "bootstrap" },
  })
  async sync(payload: any, context: TaskContext): Promise<void> {
    await context.ping();
    context.submitResult({ ok: true, source: payload["source"] });
  }
}
```

## Supported schedule variants

Exactly one schedule field must be provided:

1. Cron:

```ts
@ScheduledTask({
  name: "nightly-report",
  queue: "report",
  cron: "0 0 * * *",
})
```

2. Fixed rate:

```ts
@ScheduledTask({
  name: "refresh-cache",
  queue: "cache",
  fixedRate: 15 * 60_000,
})
```

3. Fixed delay:

```ts
@ScheduledTask({
  name: "sync-provider",
  queue: "sync",
  fixedDelay: 10 * 60_000,
})
```

## Shared options

In addition to schedule field and required identity fields (`name`, `queue`), the decorator accepts standard task settings:

- `pool` (optional, defaults to `default`)
- `startAfter`
- `priority`
- `payload`
- `timeout`
- `retries`
- `backoff`
- `backoffType`
- `missedRunStrategy`
- `replaceExisting`

## `replaceExisting` behavior

Periodic tasks are deduplicated by `name`.

- default (`replaceExisting` omitted/false): duplicate name is ignored
- `replaceExisting=true`: existing pending periodic row with the same `name` is replaced (upsert)

Replacement updates periodic schedule settings and runtime task config fields and resets execution state to pending.

If a conflicting row exists but is not pending, replace is not applied.

## Initialization lifecycle

On module initialization, the framework registrar:

1. scans providers for `@ScheduledTask(...)`
2. registers each decorated method as a queue worker

On application bootstrap, it provisions periodic definitions via:

1. `scheduleAtCron(...)`
2. `scheduleAtFixedRate(...)`
3. `scheduleAtFixedDelay(...)`

This ordering gives all modules time to initialize before schedule upserts run.

Calls map to:
- `scheduleAtCron(...)`
- `scheduleAtFixedRate(...)`
- `scheduleAtFixedDelay(...)`

## Validation and constraints

- `name` is limited to 20 characters (database constraint + runtime validation)
- exactly one of `cron`, `fixedRate`, `fixedDelay` must be set
- `@ScheduledTask(...)` cannot be combined with `@Worker(...)` on the same method
- cron schedules are evaluated in UTC in the current implementation
