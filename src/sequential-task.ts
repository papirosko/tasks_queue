import { Collection, option } from "scats";
import { ActiveChildState } from "./active-child-state.js";
import { MultiStepPayload } from "./multi-step-payload.js";
import { MultiStepTask } from "./multi-step-task.js";
import { TaskContext, TaskStateSnapshot } from "./tasks-model.js";

/**
 * Linear workflow helper built on top of {@link MultiStepTask}.
 *
 * `SequentialTask` receives an ordered list of step names and uses that list as the canonical
 * workflow order.
 *
 * Like {@link MultiStepTask}, this abstraction requires task payload to use the
 * {@link MultiStepPayload} envelope. New parent tasks should be scheduled with
 * `MultiStepPayload.forUserPayload(...)` or an equivalent `new MultiStepPayload(...)` instance,
 * and resumed parent executions are expected to keep the same envelope shape.
 *
 * Step resolution rules:
 * - on every parent execution, the current step is resolved from `workflowPayload.step`
 * - if `workflowPayload.step` is missing, `SequentialTask` falls back to the first configured
 *   step from the constructor `Collection<TStep>`
 * - when that fallback is used, the resolved first step is persisted back into
 *   `workflowPayload.step` before `processStep(...)` runs
 * - after a child task finishes successfully, `workflowPayload.step` is advanced to the next
 *   configured item in the same ordered list
 * - if the current step is already the last configured item, no further automatic transition
 *   happens
 *
 * This means the configured step list defines transition order, while the persisted
 * `workflowPayload.step` defines the current position inside that order. Fresh parent tasks may
 * omit `workflowPayload.step` entirely and let the workflow start from the first configured step
 * automatically.
 *
 * This leaves subclasses with a single responsibility: implement `processStep(...)` and branch
 * on the current step.
 *
 * Special `TaskContext.setPayload(...)` semantics inside `processStep(...)`:
 * - unlike plain `MultiStepTask`, sequential step handlers pass only the next `userPayload`
 * - `SequentialTask` wraps that value back into the full `MultiStepPayload` envelope
 * - `workflowPayload.step` remains owned by `SequentialTask` and should not be managed by
 *   subclasses directly
 *
 * The abstraction is intentionally happy-path only: the built-in behavior is "complete all
 * configured steps or fail the parent task". If a workflow needs branching recovery logic,
 * compensation, or custom error transitions, use {@link MultiStepTask} directly instead.
 *
 * If the current step is the last one in the configured sequence, successful child completion
 * does not advance to a new step and no additional processing is triggered automatically.
 *
 * Example:
 * ```ts
 * type VideoStep = "scan" | "encode" | "metadata";
 *
 * type VideoPayload = {
 *   videoId: number;
 *   sourcePath: string;
 *   encodedPath?: string;
 * };
 *
 * class ProcessUploadedVideoTask extends SequentialTask<VideoStep, VideoPayload> {
 *   static readonly QUEUE_NAME = "process-uploaded-video";
 *
 *   constructor(
 *     private readonly videosDao: VideosDao,
 *     private readonly tasks: TasksPoolsService,
 *   ) {
 *     super(Collection.of("scan", "encode", "metadata"));
 *   }
 *
 *   async onApplicationBootstrap() {
 *     this.tasks.registerWorker(ProcessUploadedVideoTask.QUEUE_NAME, this);
 *   }
 *
 *   protected async processStep(
 *     step: VideoStep,
 *     payload: VideoPayload,
 *     context: TaskContext,
 *   ): Promise<void> {
 *     switch (step) {
 *       case "scan":
 *         context.spawnChild({
 *           queue: "scan-video-antivirus",
 *           payload: {
 *             videoId: payload.videoId,
 *             path: payload.sourcePath,
 *           },
 *         });
 *         break;
 *       case "encode":
 *         const scanPassed = await this.videosDao.markCleanIfNoVirus(payload.videoId);
 *         if (!scanPassed) {
 *           await this.videosDao.updateStatus(payload.videoId, "virus");
 *           break;
 *         }
 *         context.spawnChild({
 *           queue: "encode-video-file",
 *           payload: {
 *             videoId: payload.videoId,
 *             path: payload.sourcePath,
 *           },
 *         });
 *         break;
 *       case "metadata":
 *         if (payload.encodedPath) {
 *           const encodedPath = payload.encodedPath;
 *           const metadata = await readVideoMetadata(encodedPath);
 *           await this.videosDao.updateMetadata(payload.videoId, metadata);
 *         }
 *         break;
 *     }
 *   }
 * }
 *
 * await tasks.schedule({
 *   queue: ProcessUploadedVideoTask.QUEUE_NAME,
 *   payload: MultiStepPayload.forUserPayload({
 *     videoId: 42,
 *     sourcePath: "/uploads/video.mp4",
 *   }).toJson,
 * });
 *
 * // Fresh sequential workflow: `workflowPayload.step` may be omitted.
 * // The first parent execution will start from "scan" and persist it automatically.
 * ```
 */
export abstract class SequentialTask<
  TStep extends string,
  TUserPayload extends object,
> extends MultiStepTask<TUserPayload> {
  constructor(private readonly steps: Collection<TStep>) {
    super();
  }

  /**
   * Resolve the next configured step for the current step name.
   *
   * @param currentStep current workflow step
   * @returns next step if one exists
   */
  private nextStep(currentStep: TStep) {
    const currentIdx = this.steps.indexOf(currentStep);
    if (currentIdx < 0) {
      throw new Error(`Unknown sequential step: ${currentStep}`);
    }
    return option(currentIdx + 1)
      .filter((idx) => idx < this.steps.length)
      .map((idx) => this.steps.get(idx));
  }

  /**
   * Process a concrete sequential step using the user payload for that step.
   *
   * @param step current workflow step
   * @param payload user payload
   * @param context task runtime context
   */
  protected abstract processStep(
    step: TStep,
    payload: TUserPayload,
    context: TaskContext,
  ): Promise<void>;

  /**
   * Advance workflow state to the next configured step and continue processing.
   *
   * This helper is shared by both successful child completion and allowed child failure.
   */
  private async continueToNextStep(
    payload: MultiStepPayload<TUserPayload>,
    context: TaskContext,
  ): Promise<void> {
    await this.currentStep(payload).match({
      some: async (currentStep) => {
        await this.nextStep(currentStep).match({
          some: async (step) => {
            const nextPayload = payload.copy({
              workflowPayload: {
                ...payload.workflowPayload,
                step,
              },
            });
            context.setPayload(nextPayload.toJson);
            await this.runStep(nextPayload, step, context);
          },
          none: async () => {
            // no next step configured
          },
        });
      },
      none: async () => {
        throw new Error(
          "Sequential task requires at least one configured step",
        );
      },
    });
  }

  /**
   * Adapt runtime context for sequential steps so step handlers work with user payload only.
   *
   * In `SequentialTask`, `context.setPayload(...)` inside `processStep(...)` accepts only the next
   * `userPayload`. This adapter preserves all other context operations while wrapping user payloads
   * back into the persisted multi-step envelope with the current sequential step.
   */
  private processStepContext(
    payload: MultiStepPayload<TUserPayload>,
    context: TaskContext,
    step: TStep,
    trackers?: {
      onSetPayload?: (payload: MultiStepPayload<TUserPayload>) => void;
      onSpawnChild?: () => void;
    },
  ): TaskContext {
    return {
      taskId: context.taskId,
      currentAttempt: context.currentAttempt,
      maxAttempts: context.maxAttempts,
      resolvedChildTask: context.resolvedChildTask,
      ping: () => context.ping(),
      setPayload: (userPayload: object) => {
        const nextPayload = payload.copy({
          workflowPayload: {
            ...payload.workflowPayload,
            step,
          },
          userPayload: userPayload as TUserPayload,
        });
        trackers?.onSetPayload?.(nextPayload);
        context.setPayload(nextPayload.toJson);
      },
      submitResult: (result: object) => context.submitResult(result),
      findTask: (taskId: number) => context.findTask(taskId),
      spawnChild: (task) => {
        trackers?.onSpawnChild?.();
        context.spawnChild(task);
      },
    };
  }

  private async runStep(
    payload: MultiStepPayload<TUserPayload>,
    step: TStep,
    context: TaskContext,
  ): Promise<void> {
    let effectivePayload = payload;
    let childSpawned = false;
    await this.processStep(
      step,
      payload.userPayload,
      this.processStepContext(payload, context, step, {
        onSetPayload: (nextPayload) => {
          effectivePayload = nextPayload;
        },
        onSpawnChild: () => {
          childSpawned = true;
        },
      }),
    );
    if (!childSpawned) {
      await this.continueToNextStep(effectivePayload, context);
    }
  }

  /**
   * Delegate no-child processing to {@link processStep}.
   *
   * @param payload current multi-step payload
   * @param context task runtime context
   */
  protected override async processNext(
    payload: MultiStepPayload<TUserPayload>,
    context: TaskContext,
  ): Promise<void> {
    await this.currentStep(payload).match({
      some: async (step) => {
        if (payload.workflowPayload["step"] !== step) {
          context.setPayload(
            payload.copy({
              workflowPayload: {
                ...payload.workflowPayload,
                step,
              },
            }).toJson,
          );
        }
        await this.runStep(payload, step, context);
      },
      none: async () => {
        throw new Error(
          "Sequential task requires at least one configured step",
        );
      },
    });
  }

  /**
   * Advance workflow state to the next configured step after successful child completion.
   *
 * Default behavior:
 * - update `workflowPayload.step` to the next configured step
 * - persist updated payload
 * - immediately continue with `processStep(...)`
 * - if that step finishes without `spawnChild(...)`, continue again until a
 *   child is spawned or the configured step list is exhausted
 *
 * @param payload current multi-step payload
 * @param _childTask completed child snapshot
 * @param context task runtime context
 */
  protected override async childFinished(
    payload: MultiStepPayload<TUserPayload>,
    _childTask: TaskStateSnapshot,
    context: TaskContext,
    _activeChild: ActiveChildState,
  ): Promise<void> {
    await this.continueToNextStep(payload, context);
  }

  /**
   * Continue to the next configured step when the failed child was marked with `allowFailure=true`.
   *
   * When `allowFailure` is not set, SequentialTask keeps the default MultiStepTask behavior and
   * fails the parent task.
   */
  protected override async childFailed(
    payload: MultiStepPayload<TUserPayload>,
    childTask: { id: number; error?: string },
    context: TaskContext,
    activeChild: ActiveChildState,
  ): Promise<void> {
    if (activeChild.allowFailure) {
      await this.continueToNextStep(payload, context);
      return;
    }
    await super.childFailed(payload, childTask, context, activeChild);
  }

  /**
   * Extract the current sequential step from workflow payload.
   *
   * @param payload current multi-step payload
   * @returns configured step name if present
   */
  private stepFromPayload(payload: MultiStepPayload<TUserPayload>) {
    return option(payload.workflowPayload["step"]).map((x) => x as TStep);
  }

  /**
   * Resolve current step from payload, falling back to the first configured step.
   *
   * This lets newly created sequential workflows omit `workflowPayload.step`
   * and start from the beginning of the configured sequence.
   *
   * @param payload current multi-step payload
   * @returns current step name if one can be resolved
   */
  private currentStep(payload: MultiStepPayload<TUserPayload>) {
    return this.stepFromPayload(payload).orElseValue(this.steps.headOption);
  }
}
