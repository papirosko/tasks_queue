create table tasks_queue
(
    id                   serial primary key,
    parent_id            int4                                                                                   default null references tasks_queue (id) on delete set null,
    queue                varchar(50)                                                                   not null,
    created              timestamp                                                                     not null default now(),
    initial_start        timestamp                                                                     not null default now(),
    started              timestamp                                                                              default null,
    last_heartbeat       timestamp                                                                              default null,
    finished             timestamp                                                                              default null,
    status               varchar(15) check (status in ('pending', 'in_progress', 'blocked', 'finished', 'error')) not null default 'pending',
    missed_runs_strategy varchar(30) check (missed_runs_strategy in ('catch_up', 'skip_missed'))                default 'skip_missed',
    priority             int2                                                                          not null default 0,
    error                text                                                                                   default null,
    backoff              int8                                                                                   default 60000,
    backoff_type         varchar(11) check (backoff_type in ('constant', 'linear', 'exponential'))     not null default 'linear',
    timeout              int8                                                                          not null default 3600000,
    name                 varchar(20) unique nulls distinct                                                      default null,
    start_after          timestamp                                                                              default null,
    repeat_interval      int8                                                                                   default null,
    cron_expression      text                                                                                   default null,
    repeat_type          varchar(11) check (repeat_type in ('fixed_rate', 'fixed_delay', 'cron'))               default null,
    max_attempts         int4                                                                          not null default 1,
    attempt              int4                                                                          not null default 0,
    payload              jsonb                                                                                  default null,
    result               jsonb                                                                                  default null,
    constraint tasks_queue_cron_expression_not_blank
        check (cron_expression is null or btrim(cron_expression) <> ''),
    constraint tasks_queue_repeat_config_consistency
        check (
            (repeat_type is null and repeat_interval is null and cron_expression is null)
                or
            (repeat_type in ('fixed_rate', 'fixed_delay') and repeat_interval is not null and cron_expression is null)
                or
            (repeat_type = 'cron' and cron_expression is not null and repeat_interval is null)
            )
);
CREATE INDEX ON tasks_queue (status);
CREATE INDEX ON tasks_queue (queue);
CREATE INDEX ON tasks_queue (parent_id);
CREATE INDEX ON tasks_queue (finished);
CREATE INDEX ON tasks_queue (status, queue);
CREATE INDEX ON tasks_queue (started);
CREATE INDEX ON tasks_queue (start_after);
CREATE INDEX idx_tasks_queue_next_pending
    ON tasks_queue (status, queue, priority DESC, id)
    WHERE status = 'pending';
CREATE INDEX idx_tasks_queue_peek_start_after
    ON tasks_queue (queue, status, start_after)
    WHERE status IN ('pending', 'error');
comment on column tasks_queue.id is 'The id of the queued task';
comment on column tasks_queue.parent_id is 'Optional parent task id for multi-step orchestration';
comment on column tasks_queue.queue is 'The name of the queue task belongs to';
comment on column tasks_queue.created is 'The time when the task was added to queue (created)';
comment on column tasks_queue.started is 'The time when the current processing attempt was started';
comment on column tasks_queue.last_heartbeat is 'The last confirmed heartbeat for the current processing attempt';
comment on column tasks_queue.finished is 'The time when the task was finished either successfully or with error';
comment on column tasks_queue.status is 'The current status of the task';
comment on column tasks_queue.priority is 'The priority of the task. Higher values indicate higher priority. Used to determine task processing order.';
comment on column tasks_queue.error is 'The message for the last error of the task failed to complete';
comment on column tasks_queue.backoff is 'The base backoff duration in milliseconds to wait before retrying a failed task';
comment on column tasks_queue.backoff_type is 'The strategy used to apply backoff on retries (constant, linear or exponential)';
comment on column tasks_queue.timeout is 'The duration in milliseconds after which started task will be considered as stalled';
comment on column tasks_queue.name is 'The optional unique name used to identify and deduplicate periodic tasks';
comment on column tasks_queue.start_after is 'The optional time, when the task should be started. If not set, task will be processed once the worker will fetch it';
comment on column tasks_queue.repeat_interval is 'The optional duration, after which successfully completed task will be processed again. If null, the task will be executed only once';
comment on column tasks_queue.cron_expression is 'The optional cron expression that defines periodic task executions. Supports 5-field and 6-field formats';
comment on column tasks_queue.repeat_type is 'Defines how the next execution time is calculated for repeating tasks (e.g., fixed_rate, fixed_delay, cron)';
comment on column tasks_queue.max_attempts is 'The maximum number of attempts for a task to be processed in case of failures';
comment on column tasks_queue.attempt is 'The number of attempts the task was fetched for processing';
comment on column tasks_queue.payload is 'The optional task input and persisted runtime state used during execution';
comment on column tasks_queue.result is 'The optional final result submitted by the worker after task completion';
COMMENT ON COLUMN tasks_queue.missed_runs_strategy is
    'Defines how missed runs of periodic tasks should be handled. '
        'Options: catch_up (run all missed intervals), '
        'skip_missed (schedule next future run)';
