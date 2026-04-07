# Task Heartbeat

`TaskContext.ping()` exists for long-running workers that may legitimately stay in `in_progress` for a long time without finishing.

Without heartbeats, timeout handling uses only the current attempt `started` timestamp. With heartbeats, stalled detection uses the most recent persisted liveness point instead.

## How stalled detection works

When a worker fetches a task, the queue stores `started` for that specific attempt.

If the worker calls `context.ping()`, the queue updates `last_heartbeat` for that same attempt.

Stalled detection uses:

```sql
greatest(started, coalesce(last_heartbeat, started))
```

A task is considered stalled only when:

- it is still `in_progress`
- the worker still owns the current attempt
- effective activity time plus `timeout` is older than `now`

If a task stalls:

- it becomes `pending` when retries are still available
- it becomes terminal `error` with message `Timeout` when retries are exhausted

For child tasks, a terminal timeout also wakes the blocked parent back to `pending`.

## When to use `ping()`

Use `context.ping()` when the worker:

- waits on slow external systems
- polls an external job
- streams or chunks work for a long time
- performs a long sequence inside one `process(...)` call
- remains healthy without updating payload for a long time

Short tasks usually do not need heartbeat support.

## Runtime behavior

`context.ping()` does more than "best effort heartbeat".

It first verifies that the current attempt is still healthy relative to the runtime clock. If the timeout window has already elapsed, `ping()` throws `TaskTimedOutError` and applies the same timeout transition that auxiliary stalled detection would apply.

This means:

- late heartbeat does not rescue an already timed-out attempt
- the timeout transition is applied immediately
- caller sees a runtime exception instead of a silent no-op

Similarly, when `process(...)` returns successfully, the runtime re-checks liveness before persisting success. If the timeout window has already elapsed, the task is treated as timed out instead of being marked finished.

## Throttling

Heartbeat writes are throttled to at most once per minute.

Throttling exists in two layers:

- in the runtime `TaskContext`, to suppress repeated writes from tight loops
- in the DAO update path, to protect the database even if callers invoke `ping()` too often

Because of this, calling `ping()` more often than once per minute is safe, but only one heartbeat per minute will usually be persisted.

Practical rule:

- choose task `timeout` comfortably larger than the one-minute heartbeat persistence window

If `timeout` is too small relative to heartbeat cadence, the task may still time out between persisted heartbeats even if your code calls `ping()` aggressively.

## Ownership and stale attempts

Heartbeats are bound to the current processing attempt, not just to the task id.

The runtime and DAO both check the persisted `started` timestamp of the currently owned attempt. This prevents stale workers from updating a task after ownership has already moved to a retry attempt.

Covered by integration tests:

- a stale attempt cannot heartbeat a retried task
- a stale attempt cannot finish a retried task
- a stale attempt cannot fail a retried task

So if attempt 1 stalls, the task retries as attempt 2, and attempt 1 later calls `ping()`, that heartbeat is rejected and does not touch attempt 2.

## Interaction with retries

Timeout handling uses the same retry policy as ordinary failures:

- `retries`
- `backoff`
- `backoffType`

If retries remain, timeout moves the task back to `pending` and computes the next `start_after` from the retry strategy.

If retries are exhausted, timeout moves the task to terminal `error`.

For parent-child workflows this is especially important:

- retryable child timeout keeps parent `blocked`
- terminal child timeout wakes parent back to `pending`
- parent then decides how to continue, exactly as with any other terminal child failure

## Example

```ts
class ExportReportTask extends TasksWorker {
  override async process(payload: any, context: TaskContext): Promise<void> {
    await context.ping();

    const job = await this.reportsBackend.startExport(payload["reportId"]);

    while (!(await this.reportsBackend.isReady(job.id))) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await context.ping();
    }

    context.submitResult({
      reportId: payload["reportId"],
      exportId: job.id,
    });
  }
}
```

## Tested edge cases

The integration suite covers these heartbeat-specific scenarios:

- task without heartbeat times out after `timeout`
- task with timely heartbeat stays `in_progress`
- `ping()` after timeout throws and persists timeout failure immediately
- stale attempt cannot heartbeat a retried task
- stale attempt cannot finish or fail a retried task

These guarantees matter when workers hang, clocks advance during integration tests, or timeout handling races with late async completions.

## Notes

- `started` means "when the current processing attempt began"
- `last_heartbeat` belongs only to the current attempt
- when a new attempt starts, the previous heartbeat is no longer relevant
- heartbeat is a liveness signal, not a progress signal
- `context.setPayload(...)` and `context.submitResult(...)` do not replace heartbeat for long-running tasks
