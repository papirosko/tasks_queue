# Changelog

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
