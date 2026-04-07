import { mutable } from "scats";
import { TaskStatus } from "../../../src/tasks-model.js";
import { ControlledTestWorker } from "./controlled-test-worker.js";
import { TestTaskEventsBus } from "./task-events-bus.js";

export class RecordingControlledWorker extends ControlledTestWorker {
  readonly startingCalls = new mutable.ArrayBuffer<{
    taskId: number;
    payload: any;
  }>();
  readonly completedCalls = new mutable.ArrayBuffer<{
    taskId: number;
    payload: any;
  }>();
  readonly failedCalls = new mutable.ArrayBuffer<{
    taskId: number;
    payload: any;
    finalStatus: TaskStatus;
    error: string;
  }>();

  constructor(eventsBus: TestTaskEventsBus) {
    super(eventsBus);
  }

  override starting(taskId: number, payload: any): void {
    this.startingCalls.append({ taskId, payload });
  }

  override async completed(taskId: number, payload: any): Promise<void> {
    this.completedCalls.append({ taskId, payload });
    await super.completed(taskId, payload);
  }

  override async failed(
    taskId: number,
    payload: any,
    finalStatus: TaskStatus,
    error: any,
  ): Promise<void> {
    const message =
      error !== undefined &&
      error !== null &&
      "message" in (error as Record<string, unknown>)
        ? String((error as { message: unknown }).message)
        : String(error);
    this.failedCalls.append({
      taskId,
      payload,
      finalStatus,
      error: message,
    });
    await super.failed(taskId, payload, finalStatus, error);
  }

  override reset(): void {
    super.reset();
    this.startingCalls.clear();
    this.completedCalls.clear();
    this.failedCalls.clear();
  }
}
