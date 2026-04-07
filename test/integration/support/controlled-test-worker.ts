import { mutable, none, Option, some } from "scats";
import { TaskContext, TaskStatus } from "../../../src/tasks-model.js";
import { TasksWorker } from "../../../src/tasks-worker.js";
import { TestTaskEventsBus } from "./task-events-bus.js";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type ControlledExecution = {
  context: TaskContext;
  deferred: Deferred;
};

const createDeferred = (): Deferred => {
  let resolveFn: (() => void) | undefined;
  let rejectFn: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: () => resolveFn!(),
    reject: (error: Error) => rejectFn!(error),
  };
};

export class ControlledTestWorker extends TasksWorker {
  private readonly activeExecutions =
    new mutable.HashMap<number, ControlledExecution>();
  private readonly submittedResults = new mutable.HashMap<number, object>();

  constructor(
    private readonly eventsBus: TestTaskEventsBus,
  ) {
    super();
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    const execution: ControlledExecution = {
      context,
      deferred: createDeferred(),
    };
    this.activeExecutions.put(context.taskId, execution);
    this.eventsBus.emitStarted(context.taskId, payload);
    try {
      await execution.deferred.promise;
    } finally {
      this.activeExecutions.remove(context.taskId);
    }
  }

  override async completed(taskId: number): Promise<void> {
    this.eventsBus.emitCompleted(
      taskId,
      this.submittedResults.get(taskId).orUndefined,
    );
    this.submittedResults.remove(taskId);
  }

  override async failed(
    taskId: number,
    _payload: any,
    _finalStatus: TaskStatus,
    error: any,
  ): Promise<void> {
    this.eventsBus.emitFailed(taskId, String(error?.message ?? error));
    this.submittedResults.remove(taskId);
  }

  complete(taskId: number, result?: object): void {
    this.execution(taskId).foreach((execution) => {
      optionResult(result).foreach((value) => {
        execution.context.submitResult(value);
        this.submittedResults.put(taskId, value);
      });
      execution.deferred.resolve();
    });
  }

  fail(taskId: number, error: Error): void {
    this.execution(taskId).foreach((execution) => {
      execution.deferred.reject(error);
    });
  }

  isActive(taskId: number): boolean {
    return this.execution(taskId).isDefined;
  }

  private execution(taskId: number): Option<ControlledExecution> {
    return this.activeExecutions.get(taskId);
  }
}

const optionResult = (result?: object): Option<object> =>
  result === undefined ? none : some(result);
