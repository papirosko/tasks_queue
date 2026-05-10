import { MultiStepPayload } from "./multi-step-payload.js";
import { MultiStepTask } from "./multi-step-task.js";
import { TaskContext } from "./tasks-model.js";
import { option } from "scats";

/**
 * Technical workflow state persisted in `workflowPayload` by {@link ManagedWorkflowTask}.
 */
export type ManagedWorkflowState = {
  /**
   * Number of successful parent workflow passes that entered {@link run}.
   */
  runCount: number;
};

/**
 * Base class for parent workflows that must explicitly either:
 * - spawn a child task, or
 * - submit a final result,
 * on every parent run.
 *
 * The class owns technical workflow metadata (`runCount`) inside
 * `MultiStepPayload.workflowPayload` and keeps business state in `userPayload`.
 */
export abstract class ManagedWorkflowTask<
  TUserPayload extends object = Record<string, unknown>,
> extends MultiStepTask<TUserPayload> {
  protected readonly maxRuns: number;

  constructor(maxRuns?: number) {
    super();
    this.maxRuns = ManagedWorkflowTask.validateMaxRuns(
      option(maxRuns).getOrElseValue(100),
    );
  }

  private static validateMaxRuns(value: number): number {
    const normalized = Number(value);
    if (
      !Number.isFinite(normalized) ||
      normalized <= 0 ||
      !Number.isInteger(normalized)
    ) {
      throw new Error("Managed workflow maxRuns must be a positive integer");
    }
    return normalized;
  }

  private readCurrentRunCount(payload: MultiStepPayload<TUserPayload>): number {
    const rawValue = option(
      (payload.workflowPayload as Partial<ManagedWorkflowState>).runCount,
    ).orUndefined;
    if (rawValue === undefined) {
      return 0;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `Invalid workflow runCount value: ${String(rawValue)}. runCount must be a non-negative integer`,
      );
    }
    return parsed;
  }

  /**
   * Business workflow logic supplied by subclasses.
   *
   * Contract per invocation:
   * - call `context.spawnChild(...)` exactly once, or
   * - call `context.submitResult(...)` exactly once,
   * and optionally update user payload through `context.setPayload(...)`.
   */
  protected abstract run(
    userPayload: TUserPayload,
    context: TaskContext,
  ): Promise<void>;

  protected override async processNext(
    payload: MultiStepPayload<TUserPayload>,
    context: TaskContext,
  ): Promise<void> {
    const currentRunCount = this.readCurrentRunCount(payload);
    const nextRunCount = currentRunCount + 1;

    if (nextRunCount > this.maxRuns) {
      throw new Error(
        `Workflow exceeded maximum parent runs: ${nextRunCount} > ${this.maxRuns}`,
      );
    }

    const nextPayload = payload.copy({
      workflowPayload: {
        ...payload.workflowPayload,
        runCount: nextRunCount,
      },
    });
    context.setPayload(nextPayload.toJson);

    let childSpawned = false;
    let resultSubmitted = false;

    const managedContext: TaskContext = {
      taskId: context.taskId,
      currentAttempt: context.currentAttempt,
      maxAttempts: context.maxAttempts,
      resolvedChildTask: context.resolvedChildTask,
      ping: () => context.ping(),
      findTask: (taskId: number) => context.findTask(taskId),
      setPayload: (nextUserPayload: object) => {
        const wrapped = nextPayload.copy({
          userPayload: nextUserPayload as TUserPayload,
        });
        context.setPayload(wrapped.toJson);
      },
      spawnChild: (task) => {
        if (childSpawned) {
          throw new Error(
            "Managed workflow cannot spawn more than one child in a single run",
          );
        }
        if (resultSubmitted) {
          throw new Error(
            "Managed workflow cannot spawn a child after submitting result",
          );
        }
        childSpawned = true;
        context.spawnChild(task);
      },
      submitResult: (result: object) => {
        if (resultSubmitted) {
          throw new Error(
            "Managed workflow cannot submit more than one result in a single run",
          );
        }
        if (childSpawned) {
          throw new Error(
            "Managed workflow cannot submit result after spawning a child",
          );
        }
        resultSubmitted = true;
        context.submitResult(result);
      },
    };

    await this.run(nextPayload.userPayload, managedContext);

    if (!childSpawned && !resultSubmitted) {
      throw new Error(
        "Managed workflow must either spawn a child task or submit a result in each run",
      );
    }
  }
}
