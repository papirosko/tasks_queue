import { Collection, option } from "scats";
import { MultiStepPayload } from "./multi-step-payload.js";
import { MultiStepTask } from "./multi-step-task.js";
import { TaskContext, TaskStateSnapshot } from "./tasks-model.js";

/**
 * Linear workflow helper built on top of {@link MultiStepTask}.
 *
 * `SequentialTask` receives an ordered list of step names and automatically advances
 * `workflowPayload.step` to the next configured step after a child task finishes successfully.
 * This leaves subclasses with a single responsibility: implement `processStep(...)`
 * and branch on the current step.
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
 *   constructor(
 *     private readonly videosDao: VideosDao,
 *   ) {
 *     super(Collection.of("scan", "encode", "metadata"));
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
   * Delegate no-child processing to {@link processStep}.
   *
   * @param payload current multi-step payload
   * @param context task runtime context
   */
  protected override async processNext(
    payload: MultiStepPayload<TUserPayload>,
    context: TaskContext,
  ): Promise<void> {
    await this.stepFromPayload(payload).match({
      some: async (step) => {
        await this.processStep(step, payload.userPayload, context);
      },
      none: async () => {
        throw new Error("Sequential task requires workflowPayload.step");
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
   *
   * @param payload current multi-step payload
   * @param _childTask completed child snapshot
   * @param context task runtime context
   */
  protected override async childFinished(
    payload: MultiStepPayload<TUserPayload>,
    _childTask: TaskStateSnapshot,
    context: TaskContext,
  ): Promise<void> {
    await this.stepFromPayload(payload).match({
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
            await this.processStep(step, nextPayload.userPayload, context);
          },
          none: async () => {
            // no next step configured
          },
        });
      },
      none: async () => {
        throw new Error("Sequential task requires workflowPayload.step");
      },
    });
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
}
