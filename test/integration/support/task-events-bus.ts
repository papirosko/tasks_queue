import {Collection, mutable, Option} from 'scats';

export enum TestTaskEventType {
    started = 'started',
    completed = 'completed',
    failed = 'failed',
}

export type StartedTaskEvent = {
    type: TestTaskEventType.started;
    taskId: number;
    payload: object | undefined;
};

export type CompletedTaskEvent = {
    type: TestTaskEventType.completed;
    taskId: number;
    result: object | undefined;
};

export type FailedTaskEvent = {
    type: TestTaskEventType.failed;
    taskId: number;
    error: string;
};

export type TestTaskEvent =
    | StartedTaskEvent
    | CompletedTaskEvent
    | FailedTaskEvent;

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

type CountedDeferred<TEvent extends TestTaskEvent> = {
    deferred: Deferred<TEvent>;
    occurrence: number;
};

const createDeferred = <T>(): Deferred<T> => {
    let resolveFn: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolveFn = resolve;
    });
    return {
        promise,
        resolve: (value: T) => resolveFn!(value),
    };
};

/**
 * In-memory event bus for integration tests around task lifecycle.
 *
 * The bus stores all emitted events and allows tests to await a specific lifecycle
 * transition for a task without polling the database blindly.
 */
export class TestTaskEventsBus {
    private readonly eventsByTaskId =
        new mutable.HashMap<number, mutable.ArrayBuffer<TestTaskEvent>>();
    private readonly startedWaiters =
        new mutable.HashMap<number, mutable.ArrayBuffer<CountedDeferred<StartedTaskEvent>>>();
    private readonly completedWaiters =
        new mutable.HashMap<number, mutable.ArrayBuffer<CountedDeferred<CompletedTaskEvent>>>();
    private readonly failedWaiters =
        new mutable.HashMap<number, mutable.ArrayBuffer<CountedDeferred<FailedTaskEvent>>>();

    emitStarted(taskId: number, payload?: object): StartedTaskEvent {
        const event: StartedTaskEvent = {
            type: TestTaskEventType.started,
            taskId,
            payload,
        };
        this.appendEvent(event);
        this.resolveWaiters(taskId, event, this.startedWaiters);
        return event;
    }

    emitCompleted(taskId: number, result?: object): CompletedTaskEvent {
        const event: CompletedTaskEvent = {
            type: TestTaskEventType.completed,
            taskId,
            result,
        };
        this.appendEvent(event);
        this.resolveWaiters(taskId, event, this.completedWaiters);
        return event;
    }

    emitFailed(taskId: number, error: string): FailedTaskEvent {
        const event: FailedTaskEvent = {
            type: TestTaskEventType.failed,
            taskId,
            error,
        };
        this.appendEvent(event);
        this.resolveWaiters(taskId, event, this.failedWaiters);
        return event;
    }

    events(taskId: number): Collection<TestTaskEvent> {
        return this.eventsByTaskId
            .get(taskId)
            .map((events) => Collection.from(events.toArray))
            .getOrElseValue(Collection.from<TestTaskEvent>([]));
    }

    waitForStarted(taskId: number, occurrence: number = 1): Promise<StartedTaskEvent> {
        return this.findEvent(taskId, TestTaskEventType.started, occurrence).match({
            some: (event) => Promise.resolve(event as StartedTaskEvent),
            none: () => this.registerWaiter(taskId, occurrence, this.startedWaiters).promise,
        });
    }

    waitForCompleted(taskId: number, occurrence: number = 1): Promise<CompletedTaskEvent> {
        return this.findEvent(taskId, TestTaskEventType.completed, occurrence).match({
            some: (event) => Promise.resolve(event as CompletedTaskEvent),
            none: () => this.registerWaiter(taskId, occurrence, this.completedWaiters).promise,
        });
    }

    waitForFailed(taskId: number, occurrence: number = 1): Promise<FailedTaskEvent> {
        return this.findEvent(taskId, TestTaskEventType.failed, occurrence).match({
            some: (event) => Promise.resolve(event as FailedTaskEvent),
            none: () => this.registerWaiter(taskId, occurrence, this.failedWaiters).promise,
        });
    }

    latest(taskId: number): Option<TestTaskEvent> {
        return this.events(taskId).lastOption;
    }

    reset(): void {
        this.eventsByTaskId.clear();
        this.startedWaiters.clear();
        this.completedWaiters.clear();
        this.failedWaiters.clear();
    }

    private appendEvent(event: TestTaskEvent): void {
        const events = this.eventsByTaskId
            .get(event.taskId)
            .getOrElse(() => new mutable.ArrayBuffer<TestTaskEvent>());
        events.append(event);
        this.eventsByTaskId.put(event.taskId, events);
    }

    private findEvent(
        taskId: number,
        type: TestTaskEventType,
        occurrence: number,
    ): Option<TestTaskEvent> {
        return this.events(taskId)
            .filter((event) => event.type === type)
            .drop(occurrence - 1)
            .headOption;
    }

    private registerWaiter<TEvent extends TestTaskEvent>(
        taskId: number,
        occurrence: number,
        waitersMap: mutable.HashMap<number, mutable.ArrayBuffer<CountedDeferred<TEvent>>>,
    ): Deferred<TEvent> {
        const deferred = createDeferred<TEvent>();
        const waiters = waitersMap
            .get(taskId)
            .getOrElse(() => new mutable.ArrayBuffer<CountedDeferred<TEvent>>());
        waiters.append({
            deferred,
            occurrence,
        });
        waitersMap.put(taskId, waiters);
        return deferred;
    }

    private resolveWaiters<TEvent extends TestTaskEvent>(
        taskId: number,
        event: TEvent,
        waitersMap: mutable.HashMap<number, mutable.ArrayBuffer<CountedDeferred<TEvent>>>,
    ): void {
        waitersMap.get(taskId).foreach((waiters) => {
            const matched = this.events(taskId)
                .count((storedEvent) => storedEvent.type === event.type);
            const pending = new mutable.ArrayBuffer<CountedDeferred<TEvent>>();
            waiters.foreach((waiter) => {
                if (waiter.occurrence <= matched) {
                    waiter.deferred.resolve(event);
                } else {
                    pending.append(waiter);
                }
            });
            if (pending.nonEmpty) {
                waitersMap.put(taskId, pending);
            } else {
                waitersMap.remove(taskId);
            }
        });
    }
}
