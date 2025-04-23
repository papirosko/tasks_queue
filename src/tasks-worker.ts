/* eslint-disable */

import { TaskStatus } from './tasks-model.js';

/**
 * Base class for a worker that processes tasks from a queue.
 *
 * Extend this class to define how a specific task should be handled.
 * You must implement the `process()` method. Other lifecycle methods
 * are optional and can be overridden to add custom behavior.
 */
export abstract class TasksWorker {
    /**
     * Process the payload of a task.
     *
     * This method **must** be implemented by subclasses. It contains
     * the main logic that should be executed when the task is picked up.
     *
     * @param payload - The data provided to the task.
     */
    abstract process(payload: any): Promise<void>;

    /**
     * Called right before the task is processed.
     *
     * Override this to implement custom behavior that should happen
     * before processing starts (e.g., logging, tracing, state updates).
     *
     * Default implementation does nothing.
     *
     * @param taskId - The unique identifier of the task.
     * @param payload - The data provided to the task.
     */
    starting(taskId: number, payload: any): void {}

    /**
     * Called after the task has been successfully completed.
     *
     * Override this to implement actions that should happen after
     * successful execution (e.g., scheduling next task, notifications).
     *
     * Default implementation does nothing.
     *
     * @param taskId - The unique identifier of the task.
     * @param payload - The data provided to the task.
     */
    completed(taskId: number, payload: any): void {}

    /**
     * Called if the task has failed.
     *
     * Override this to handle task failure.
     *
     * You can use the `finalStatus` parameter to determine whether the
     * task will be retried again (`'pending'`) or if it's terminally
     * failed (`'error'`).
     *
     * Default implementation does nothing.
     *
     * @param taskId - The unique identifier of the task.
     * @param payload - The data provided to the task.
     * @param finalStatus - Final status of the task: `'pending'` if it will be retried,
     *                      or `'error'` if it won't be retried anymore.
     * @param error - the error, raised during the task execution.

     */
    failed(taskId: number, payload: any, finalStatus: TaskStatus, error: any): void {}
}
