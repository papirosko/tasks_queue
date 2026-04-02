import { option, Option } from "scats";
import { ActiveChildState } from "./active-child-state.js";

/**
 * Persisted payload envelope for stateful parent-child workflows.
 *
 * The envelope separates orchestration state owned by the workflow runtime from
 * user business payload and optional active child metadata.
 */
export class MultiStepPayload<
  TUserPayload extends object = Record<string, unknown>,
> {
  constructor(
    /**
     * Currently active child task metadata, if the parent is blocked waiting for it.
     */
    readonly activeChild: Option<ActiveChildState>,
    /**
     * Workflow-owned orchestration state.
     */
    readonly workflowPayload: Record<string, any>,
    /**
     * Domain-specific business payload owned by the workflow implementation.
     */
    readonly userPayload: TUserPayload,
  ) {}

  /**
   * Create a shallow copy with selected envelope parts replaced.
   */
  copy(
    o: Partial<MultiStepPayload<TUserPayload>>,
  ): MultiStepPayload<TUserPayload> {
    return new MultiStepPayload<TUserPayload>(
      option(o.activeChild).getOrElseValue(this.activeChild),
      option(o.workflowPayload).getOrElseValue(this.workflowPayload),
      option(o.userPayload).getOrElseValue(this.userPayload),
    );
  }

  /**
   * Serialize the envelope into plain JSON suitable for task payload persistence.
   */
  get toJson(): object {
    const res: Record<string, unknown> = {
      workflowPayload: this.workflowPayload,
      userPayload: this.userPayload,
    };
    this.activeChild.foreach((activeChild) => {
      res["activeChild"] = activeChild.toJson;
    });
    return res;
  }

  /**
   * Deserialize workflow envelope from plain JSON payload.
   *
   * For backward compatibility this also reads legacy `activeChildId` payloads.
   */
  static fromJson<TUserPayload extends object>(
    j: unknown,
  ): MultiStepPayload<TUserPayload> {
    const o = option(j).map((x) => x as Record<string, unknown>);
    return new MultiStepPayload<TUserPayload>(
      o.flatMap((x) =>
        ActiveChildState.fromJson(x["activeChild"]).match({
          some: (activeChild) => option(activeChild),
          none: () =>
            option(x["activeChildId"]).map(
              (taskId) => new ActiveChildState(Number(taskId)),
            ),
        }),
      ),
      o
        .flatMap((x) => option(x["workflowPayload"]))
        .map((x) => x as Record<string, any>)
        .getOrElseValue({}),
      o
        .flatMap((x) => option(x["userPayload"] as TUserPayload))
        .getOrElseValue({} as TUserPayload),
    );
  }
}
