create table tasks_queue
(
    id              serial primary key,
    queue           varchar(50)                                                                   not null,
    created         timestamp                                                                     not null default now(),
    started         timestamp                                                                              default null,
    finished        timestamp                                                                              default null,
    status          varchar(15) check (status in ('pending', 'in_progress', 'finished', 'error')) not null default 'pending',
    priority        int2                                                                          not null default 0,
    error           text                                                                                   default null,
    backoff         int8                                                                                   default 60000,
    backoff_type    varchar(11) check (backoff_type in ('constant', 'linear', 'exponential'))     not null default 'linear',
    timeout         int8                                                                          not null default 3600000,
    name            varchar(20) unique nulls distinct                                                      default null,
    start_after     timestamp                                                                              default null,
    repeat_interval int8                                                                                   default null,
    repeat_type     varchar(11) check (repeat_type in ('fixed_rate', 'fixed_delay'))                       default null,
    max_attempts    int4                                                                          not null default 1,
    attempt         int4                                                                          not null default 0,
    payload         jsonb                                                                                  default null
);
CREATE INDEX ON tasks_queue (status);
CREATE INDEX ON tasks_queue (queue);
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
comment on column tasks_queue.queue is 'The name of the queue task belongs to';
comment on column tasks_queue.created is 'The time when the task was added to queue (created)';
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
comment on column tasks_queue.repeat_type is 'Defines how the next execution time is calculated for repeating tasks (e.g., fixed_rate, fixed_delay)';
comment on column tasks_queue.max_attempts is 'The maximum number of attempts for a task to be processed in case of failures';
comment on column tasks_queue.attempt is 'The number of attempts the task was fetched for processing';
comment on column tasks_queue.payload is 'The optional data for the worker, that will process this task';
