# Changelog

## 1.7.6

### Fixed
- Fixed `SequentialTask` auto-continue semantics so steps that run after an intermediate local step do not retain stale `resolvedChildTask` from an earlier child completion.
- Fixed `TasksPoolsService.stop()` to clear its shutdown timeout timer after successful stop, preventing Jest open-handle warnings in test runs.

### Added
- Added unit coverage that verifies auto-continued sequential steps receive updated payload while stale child references are cleared.
- Added unit coverage for shutdown timeout cleanup in `TasksPoolsService.stop()`.

## 1.7.5

### Fixed
- Fixed cross-pool parent-child notifications so child tasks scheduled into another pool start immediately instead of waiting for that pool's next polling interval.
- Fixed blocked parent wake-up notifications so parents resume immediately even when the completed child ran in a different pool.

### Added
- Added unit coverage for cross-pool queue notification dispatch in `TasksQueueWorker`.
- Added an integration test that reproduces cross-pool parent-child execution with `loopInterval = 1 minute` and verifies prompt child start and parent wake-up.
- Added unit and integration coverage for `SequentialTask` flows that contain intermediate steps without `spawnChild(...)`, including database assertions for persisted parent payload and final result.

### Changed
- Changed `SequentialTask` so a step that finishes without `context.spawnChild(...)` automatically advances to the next configured step in the same parent execution.
- Updated README and multi-step workflow documentation to describe mixed sequential flows such as `child -> local step -> child`.

## 1.7.4

### Added
- Added a real PostgreSQL integration test harness based on `testcontainers`.
- Added integration coverage for task execution lifecycle, parent-child workflows, stalled-task handling, periodic scheduling, lifecycle callbacks, management APIs, DAO cleanup flows, and ownership race scenarios.
- Added broader public API JSDoc across queue services, models, scheduling APIs, and NestJS integration types.

### Changed
- Hardened task ownership checks so stale attempts cannot heartbeat, finish, fail, block, or wake tasks after ownership has moved to a newer attempt.
- Refined `SequentialTask` payload handling and expanded workflow-specific coverage around parent-child continuations.
- Enabled coverage reporting for the integration suite and aligned the repository with the new ESLint ruleset.
- Expanded README and detailed documentation for heartbeat behavior, multi-step workflows, and operational usage.

## 1.7.3

### Fixed
- Fixed terminal failure persistence so submitted `result` is retained for terminal task failures instead of being cleared incorrectly.

## 1.7.2

### Changed
- Improved `MultiStepPayload` ergonomics for parent-child workflows.
- Refined `SequentialTask` continuation behavior and expanded related workflow coverage and documentation.

## 1.7.1

### Changed
- Prevented deletion of finished tasks while any ancestor in the parent chain is still unfinished.

## 1.7.0

### Added
- Added optional `result jsonb` column to `tasks_queue` for explicit final task output persistence.
- Added `TaskContext.submitResult(...)` for workers to submit final task output independently from `setPayload(...)`.

### Changed
- `TaskStateSnapshot` and management task views now expose optional `result`.
- Parent-child orchestration now reads child output from `childTask.result` instead of overloading `childTask.payload`.
- Runtime persistence keeps `payload` as task input/runtime state and stores `result` only on completed runs or terminal failures.

### Migration
Apply the following SQL to existing databases:

```sql
ALTER TABLE tasks_queue
    ADD COLUMN IF NOT EXISTS result jsonb DEFAULT NULL;

COMMENT ON COLUMN tasks_queue.result IS
    'The optional final result submitted by the worker after task completion';
```

## 1.6.0

### Added
- Added `ActiveChildState` and `MultiStepPayload.activeChild` to persist active child orchestration metadata.
- Added optional `allowFailure` flag to `TaskContext.spawnChild(...)` child scheduling details so parent workflows can continue from `childFailed(...)` without masking child `error` status.

### Changed
- `MultiStepTask.childFinished(...)` and `MultiStepTask.childFailed(...)` now receive `activeChild` metadata, and `childFailed(...)` also receives `context` for continuation flows.
- `TaskContext` now exposes `resolvedChildTask` as `Option<TaskStateSnapshot>` during parent continuation after child resolution.
- `MultiStepPayload.fromJson(...)` now reads both the new `activeChild` structure and legacy `activeChildId` payloads for backward compatibility.

## 1.5.0

### Added
- Added support for parent-child task relations with `parent_id`.
- Added `blocked` task status for multi-step orchestration flows.
- Added `TaskContext.spawnChild(...)` for declarative child task scheduling from a parent task.
- Added `TaskContext.taskId`, `TaskContext.setPayload(...)`, and `TaskContext.findTask(...)` for workflow-aware task execution.
- Added `TaskContext.ping()` and persistent task heartbeats for long-running workers.
- Added `MultiStepPayload` with separate `workflowPayload`, `userPayload`, and `activeChildId`.
- Added `MultiStepTask` for custom state-machine workflows with one active child at a time.
- Added `SequentialTask` for happy-path sequential workflows that either complete all configured steps or fail.

### Changed
- Parent tasks are now automatically moved to `blocked` after successful child scheduling and woken up only when the child reaches a terminal state.
- Stalled child tasks now wake blocked parents when they end in terminal `error`.
- Stalled task detection now uses the latest heartbeat when available instead of relying only on `started`.

### Migration
Apply the following SQL to existing databases:

```sql
ALTER TABLE tasks_queue
    ADD COLUMN IF NOT EXISTS parent_id int4 DEFAULT NULL
        REFERENCES tasks_queue (id) ON DELETE SET NULL;

ALTER TABLE tasks_queue
    ADD COLUMN IF NOT EXISTS last_heartbeat timestamp DEFAULT NULL;

ALTER TABLE tasks_queue
    DROP CONSTRAINT IF EXISTS tasks_queue_status_check;

ALTER TABLE tasks_queue
    ADD CONSTRAINT tasks_queue_status_check
        CHECK (status IN ('pending', 'in_progress', 'blocked', 'finished', 'error'));

CREATE INDEX IF NOT EXISTS tasks_queue_parent_id_idx
    ON tasks_queue (parent_id);
```

## 1.4.2

### Added
- Management service now provides `deleteTask(taskId)` for deleting tasks only in `pending`, `error`, or `finished` status.

## 1.4.1

### Fixed
- Management API task mapping now reads `missed_runs_strategy` from the database correctly, so `missedRunStrategy` is returned in task DTO/view payloads.

## 1.4.0

### Added
- Management methods to load a task by id and update pending task runtime settings.
- Separate management method to update periodic schedule fields for pending periodic tasks.
- Optional queue filter for task search parameters.

### Changed
- Renamed management search method from `findByStatus(...)` to `findByParameters(...)`.

## 1.3.0

### Added
- Cron-based periodic scheduling support with `repeat_type='cron'`.
- New `cron_expression` column in `tasks_queue` for storing cron schedules.

### Migration
Apply the following SQL to existing databases:

```sql
-- Add a dedicated column for cron schedules
ALTER TABLE tasks_queue
    ADD COLUMN IF NOT EXISTS cron_expression text DEFAULT NULL;

-- Recreate repeat_type check to allow cron
ALTER TABLE tasks_queue
    DROP CONSTRAINT IF EXISTS tasks_queue_repeat_type_check;

ALTER TABLE tasks_queue
    ADD CONSTRAINT tasks_queue_repeat_type_check
        CHECK (repeat_type IN ('fixed_rate', 'fixed_delay', 'cron'));

-- Ensure cron expression is never blank when provided
ALTER TABLE tasks_queue
    DROP CONSTRAINT IF EXISTS tasks_queue_cron_expression_not_blank;

ALTER TABLE tasks_queue
    ADD CONSTRAINT tasks_queue_cron_expression_not_blank
        CHECK (cron_expression IS NULL OR btrim(cron_expression) <> '');

-- Keep interval and cron fields mutually exclusive and consistent with repeat_type
ALTER TABLE tasks_queue
    DROP CONSTRAINT IF EXISTS tasks_queue_repeat_config_consistency;

ALTER TABLE tasks_queue
    ADD CONSTRAINT tasks_queue_repeat_config_consistency
        CHECK (
            (repeat_type IS NULL AND repeat_interval IS NULL AND cron_expression IS NULL)
                OR
            (repeat_type IN ('fixed_rate', 'fixed_delay') AND repeat_interval IS NOT NULL AND cron_expression IS NULL)
                OR
            (repeat_type = 'cron' AND cron_expression IS NOT NULL AND repeat_interval IS NULL)
        );
```
