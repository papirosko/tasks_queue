# Changelog

## 1.5.0

### Added
- Added support for parent-child task relations with `parent_id`.
- Added `blocked` task status for multi-step orchestration flows.
- Added `TaskContext.spawnChild(...)` for declarative child task scheduling from a parent task.
- Added `TaskContext.taskId`, `TaskContext.setPayload(...)`, and `TaskContext.findTask(...)` for workflow-aware task execution.
- Added `MultiStepPayload` with separate `workflowPayload`, `userPayload`, and `activeChildId`.
- Added `MultiStepTask` for custom state-machine workflows with one active child at a time.
- Added `SequentialTask` for happy-path sequential workflows that either complete all configured steps or fail.

### Changed
- Parent tasks are now automatically moved to `blocked` after successful child scheduling and woken up only when the child reaches a terminal state.
- Stalled child tasks now wake blocked parents when they end in terminal `error`.

### Migration
Apply the following SQL to existing databases:

```sql
ALTER TABLE tasks_queue
    ADD COLUMN IF NOT EXISTS parent_id int4 DEFAULT NULL
        REFERENCES tasks_queue (id) ON DELETE SET NULL;

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
