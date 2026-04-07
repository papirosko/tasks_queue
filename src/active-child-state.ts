import { option } from "scats";

/**
 * Persisted orchestration metadata for the currently active child task of a
 * {@link MultiStepPayload multi-step workflow}.
 */
export class ActiveChildState {
  constructor(
    /**
     * Persistent id of the spawned child task.
     */
    readonly taskId: number,
    /**
     * Whether parent workflow may continue from `childFailed(...)` when this child
     * reaches terminal `error`.
     *
     * This flag does not change the child task status itself.
     */
    readonly allowFailure: boolean = false,
  ) {}

  /**
   * Create a shallow copy with selected fields replaced.
   *
   * @param o replacement fields
   * @returns copied state with overrides applied
   */
  copy(o: Partial<ActiveChildState>): ActiveChildState {
    return new ActiveChildState(
      option(o.taskId).map(Number).getOrElseValue(this.taskId),
      option(o.allowFailure).map(Boolean).getOrElseValue(this.allowFailure),
    );
  }

  /**
   * Serialize active child state into plain JSON for task payload persistence.
   *
   * @returns plain object suitable for embedding into {@link MultiStepPayload.toJson}
   */
  get toJson(): object {
    const res: Record<string, unknown> = {
      taskId: this.taskId,
    };
    option(this.allowFailure)
      .filter((x) => x)
      .foreach((allowFailure) => {
        res["allowFailure"] = allowFailure;
      });
    return res;
  }

  /**
   * Deserialize active child state from plain JSON payload.
   *
   * @param j serialized active-child payload
   * @returns parsed active-child state or `none` if the payload does not contain one
   */
  static fromJson(j: unknown) {
    return option(j)
      .map((x) => x as Record<string, unknown>)
      .flatMap((x) =>
        option(x["taskId"]).map(
          (taskId) =>
            new ActiveChildState(
              Number(taskId),
              option(x["allowFailure"]).map(Boolean).getOrElseValue(false),
            ),
        ),
      );
  }
}
