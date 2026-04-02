# Task Heartbeat

`TaskContext.ping()` is intended for long-running workers that may legitimately stay in `in_progress` for longer than their regular task logic would allow without additional activity.

## How It Works

When a task is fetched by a worker, the queue stores `started` for the current attempt.

If the worker calls `context.ping()`, the queue updates `last_heartbeat` for that task. Stalled detection then uses the most recent activity timestamp:

```sql
greatest(started, coalesce(last_heartbeat, started))
```

A task is considered stalled only when that effective activity time plus `timeout` is older than the current time.

## When To Use

Use `context.ping()` when the worker:

- waits on slow external systems;
- performs long polling or streaming;
- executes large multi-step logic inside a single `process(...)` call;
- can stay healthy for a long time without changing task payload.

Short tasks usually do not need heartbeats.

## Throttling

Heartbeat writes are throttled to at most once per minute.

The throttling is applied in two places:

- in the runtime `TaskContext`, to avoid repeated writes from tight loops;
- in the DAO SQL update, to keep the database protected even if `ping()` is called too often.

Because of this, it is safe to call `context.ping()` more often than once per minute, but only one heartbeat per minute will be persisted.

## Example

```ts
class ExportReportTask extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    await context.ping();
    const job = await this.reportsBackend.startExport(payload["reportId"]);

    while (!(await this.reportsBackend.isReady(job.id))) {
      await sleep(5000);
      await context.ping();
    }

    await this.reportsBackend.download(job.id);
  }
}
```

## Notes

- `started` still means "when the current attempt began".
- `last_heartbeat` only tracks liveness for the current attempt.
- When a task is fetched again for a new attempt, the previous heartbeat is cleared.
