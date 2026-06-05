# Runtime Metrics

The queue exposes runtime metrics through `application-metrics`.

These metrics describe in-memory worker state: pool composition, polling loop
health, concurrency slot usage, and per-queue processing activity. They are
intended to complement database statistics from `ManageTasksQueueService`.

Metric names are sanitized before registration. Any character outside
`[a-zA-Z0-9_:]` is replaced with `_`.

## Pool Composition

### `tasks_queue_pool_<pool>_queues`

Type: label

Value: comma-separated list of queue names registered in the pool, sorted
alphabetically.

Example:

```text
tasks_queue_pool_default_queues = "email,notifications,payouts"
```

Expected behavior:

- changes when workers are registered
- stays stable after application bootstrap in most deployments
- does not monotonically grow or decrease

Use this to confirm that a queue is registered in the pool you expect.

`application-metrics` labels are visible in `toJson()` and `toConsole()`. They
are not emitted by `toPrometheus()`.

## Queue Polling

### `tasks_queue_queue_<queue>_poll_total`

Type: counter

Increments once for each pool polling attempt that includes this queue in the
registered queue set.

Expected behavior:

- monotonically increases while the owning pool is polling
- should keep increasing even when there are no eligible tasks in the queue
- stops increasing if the pool loop is stopped, stuck, or the queue is not
  registered

Important: the DAO currently polls all queues in a pool with one SQL query.
This metric means "the poll included this queue", not "a separate SQL query was
made for this queue".

### `tasks_queue_queue_<queue>_fetched_total`

Type: counter

Increments when `nextPending(...)` returns a task from this queue.

Expected behavior:

- monotonically increases when tasks from the queue are selected for work
- may stay flat while `poll_total` grows if no eligible task exists
- may stay flat while `poll_total` grows if another eligible queue is selected
  by priority and id ordering

Use `poll_total` and `fetched_total` together to distinguish "not polled" from
"polled but no task selected".

## Pool Slots

### `tasks_queue_pool_<pool>_slots_total`

Type: gauge

Value: configured concurrency level for the pool.

Expected behavior:

- normally constant for the lifetime of the process
- changes only after restart or reconfiguration

### `tasks_queue_pool_<pool>_slots_busy`

Type: gauge

Value: number of in-memory processing slots currently occupied in the pool.

Expected behavior:

- increases when tasks are handed off to `processTaskInLoop(...)`
- decreases when task processing finishes
- should be between `0` and `slots_total`
- if it remains equal to `slots_total`, the pool is saturated

If tasks are `pending` with `attempt = 0` and `slots_busy = slots_total`, the
pool may simply have no free processing slots.

## Pool Loop Health

### `tasks_queue_pool_<pool>_loop_running`

Type: gauge

Value:

- `1` while the pool polling loop is currently executing
- `0` while the loop is idle or sleeping

Expected behavior:

- briefly flips to `1` during polling passes
- returns to `0` after the pass finishes

If this remains `1` for a long time while `slots_busy = 0`, the loop may be
stuck before fetching any task, for example in `nextPending(...)`,
`peekNextStartAfter(...)`, a database connection wait, or a database query.

### `tasks_queue_pool_<pool>_loop_running_ms`

Type: gauge

Value: duration in milliseconds of the current active loop pass.

Expected behavior:

- `0` when `loop_running = 0`
- grows while `loop_running = 1`
- resets to `0` after the loop pass finishes

This is the primary metric for detecting an in-memory stuck polling pass.

### `tasks_queue_pool_<pool>_loop_last_poll_duration_ms`

Type: gauge

Value: duration in milliseconds of the last completed loop pass.

Expected behavior:

- updates after each completed loop pass
- may be `0` before the first loop pass completes or when time is mocked in
  tests
- should usually be small compared to `loopInterval`

Use this as the normal baseline for loop duration. Compare it with
`loop_running_ms` during incidents.

### `tasks_queue_pool_<pool>_loop_last_poll_started_at`

Type: gauge

Value: Unix timestamp in milliseconds when the latest loop pass started.

Expected behavior:

- updates when a new loop pass begins
- remains unchanged while the pool is sleeping

### `tasks_queue_pool_<pool>_loop_last_poll_finished_at`

Type: gauge

Value: Unix timestamp in milliseconds when the latest loop pass finished.

Expected behavior:

- updates when a loop pass finishes
- should move forward over time while the pool is healthy

If this timestamp is stale while tasks are being scheduled, inspect
`loop_running`, `loop_running_ms`, and `poll_total`.

### `tasks_queue_pool_<pool>_loop_last_successful_poll_at`

Type: gauge

Value: Unix timestamp in milliseconds when the latest loop pass completed
successfully.

Expected behavior:

- updates after successful loop passes
- should usually match `loop_last_poll_finished_at`
- stays behind `loop_last_poll_finished_at` if loop passes are finishing through
  an error path

### `tasks_queue_pool_<pool>_loop_next_at`

Type: gauge

Value: Unix timestamp in milliseconds for the next scheduled loop timer.

Expected behavior:

- updates when the loop schedules its next timer
- moves closer when the pipeline reduces sleep because a future `start_after`
  is nearer than `loopInterval`

Use this to understand whether the pool is sleeping until a future delayed or
periodic task.

### `tasks_queue_pool_<pool>_loop_poll_started_total`

Type: counter

Increments when a loop pass begins.

Expected behavior:

- monotonically increases while the pool is polling
- should increase together with queue `poll_total` when registered queues exist

### `tasks_queue_pool_<pool>_loop_poll_finished_total`

Type: counter

Increments when a loop pass finishes.

Expected behavior:

- monotonically increases
- should usually track `loop_poll_started_total`

If `loop_poll_started_total` is ahead of `loop_poll_finished_total` and
`loop_running_ms` keeps growing, a loop pass is currently stuck or long-running.

## Task Lifecycle

### `tasks_queue_queue_<queue>_task_started_total`

Type: counter

Increments when a fetched task has a registered worker and enters worker
processing.

Expected behavior:

- monotonically increases when tasks from the queue start processing
- should usually track `fetched_total`

If `fetched_total` grows but `task_started_total` does not, tasks may be fetched
without a registered worker.

### `tasks_queue_queue_<queue>_task_finished_total`

Type: counter

Increments when worker processing succeeds and the successful outcome is
persisted.

Expected behavior:

- monotonically increases on successful task completion
- should never decrease

It may be lower than `task_started_total` when tasks fail, retry, time out, or
are still running.

### `tasks_queue_queue_<queue>_task_failed_<final_status>_total`

Type: counter

Increments when worker processing fails.

`final_status` is the status returned by failure handling:

- `pending`: retryable failure, task was re-queued
- `error`: terminal failure

Expected behavior:

- monotonically increases on failed attempts
- `pending` failures may later be followed by a successful finish
- `error` failures indicate terminal task failure

### `tasks_queue_queue_<queue>_task_skipped_no_worker_total`

Type: counter

Increments when a task is fetched but no worker is registered for its queue.

Expected behavior:

- should normally stay at `0`
- any increase means queue registration and polling state should be inspected

## Diagnostic Checks

### Pending tasks with `attempt = 0`

When tasks stay `pending` with `attempt = 0`, inspect these metrics in order:

1. `tasks_queue_pool_<pool>_queues`

Confirm the queue is listed in the expected pool.

2. `tasks_queue_queue_<queue>_poll_total`

If it is not increasing, the pool is not polling that queue. Check
`loop_running`, `loop_running_ms`, `loop_last_poll_finished_at`, and whether the
worker was registered.

3. `tasks_queue_queue_<queue>_fetched_total`

If `poll_total` increases but `fetched_total` does not, the queue is being
polled but no task is selected. Check task eligibility in the database:
`status = 'pending'`, `attempt < max_attempts`, and `start_after <= now()`.
Also check whether another queue in the same pool is being selected first by
priority and id ordering.

4. `tasks_queue_pool_<pool>_slots_busy` and
   `tasks_queue_pool_<pool>_slots_total`

If `slots_busy = slots_total`, the pool is saturated. Look for long-running
workers or stalled tasks.

5. `tasks_queue_pool_<pool>_loop_running` and
   `tasks_queue_pool_<pool>_loop_running_ms`

If `loop_running = 1`, `loop_running_ms` keeps growing, and `slots_busy = 0`,
the loop is likely stuck before fetching a task.

### Metrics that should move together

- `tasks_queue_pool_<pool>_loop_poll_started_total` and
  `tasks_queue_pool_<pool>_loop_poll_finished_total` should usually stay close.
  A widening gap means a loop pass is running or stuck.

- `tasks_queue_queue_<queue>_poll_total` should increase when the owning pool
  loop starts and the queue is registered.

- `tasks_queue_queue_<queue>_fetched_total` should be less than or equal to
  `tasks_queue_queue_<queue>_poll_total`.

- `tasks_queue_queue_<queue>_task_started_total` should be less than or equal to
  `tasks_queue_queue_<queue>_fetched_total`.

- `task_finished_total + task_failed_pending_total +
  task_failed_error_total + currently_running` should explain most of
  `task_started_total`.

- `slots_busy` should not exceed `slots_total`.

### When database stats are better

Use database-backed management APIs for historical and persisted facts:

- queue/status counts
- wait-time and work-time statistics
- specific task state and payload
- failed task inspection
- retry and timeout history

Use runtime metrics for process-local facts that the database cannot show:

- registered queue list per pool
- whether polling includes a queue
- in-memory busy slots
- whether the polling loop is currently stuck
