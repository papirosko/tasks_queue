import { ActiveChildState } from "./active-child-state.js";
import { MultiStepPayload } from "./multi-step-payload.js";
import { none, some } from "scats";
import { TaskContext, TaskStateSnapshot, TaskStatus } from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";

/**
 * Base worker for stateful multi-step workflows built on top of parent-child tasks.
 *
 * `MultiStepTask` expects task payload to follow the {@link MultiStepPayload} contract:
 * - `workflowPayload` stores orchestration state managed by the workflow itself
 * - `userPayload` stores domain-specific business data
 * - `activeChild` stores the currently running child task state, if any
 *
 * Execution flow:
 * 1. If `activeChild` is empty, the worker calls {@link processNext}.
 * 2. If `activeChild` is present, the worker loads the child task through `context.findTask(...)`.
 * 3. Once the child is terminal, the worker clears `activeChild`, persists updated payload,
 *    and dispatches to {@link childFinished} or {@link childFailed}.
 * 4. Default `childFinished(...)` continues with {@link processNext}, while default
 *    `childFailed(...)` fails the parent task.
 *
 * This class is intended for workflows where orchestration decisions depend on child task
 * results, custom transitions, or non-trivial recovery behavior. If the workflow is strictly
 * sequential and follows a simple happy-path "run all steps or fail" model, prefer
 * {@link SequentialTask}.
 *
 * The abstraction supports one active child at a time. Parallel branches and workflow graphs
 * are intentionally out of scope.
 *
 * Example:
 * ```ts
 * type VideoWorkflowPayload = {
 *   stage: "scan" | "after-scan" | "encode" | "metadata" | "done";
 * };
 *
 * type VideoPayload = {
 *   videoId: number;
 *   sourcePath: string;
 *   encodedPath?: string;
 * };
 *
 * class EncodeUploadedVideoTask extends MultiStepTask<VideoPayload> {
 *   constructor(
 *     private readonly videosDao: VideosDao,
 *     private readonly transcoderBackend: TranscoderBackend,
 *   ) {
 *     super();
 *   }
 *
 *   protected async processNext(
 *     payload: MultiStepPayload<VideoPayload>,
 *     context: TaskContext,
 *   ): Promise<void> {
 *     const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];
 *     switch (stage) {
 *       case "scan":
 *         context.spawnChild({
 *           queue: "scan-video-antivirus",
 *           payload: {
 *             videoId: payload.userPayload.videoId,
 *             path: payload.userPayload.sourcePath,
 *           },
 *         });
 *         break;
 *       case "after-scan":
 *         if (payload.workflowPayload["virusesFound"] === true) {
 *           await this.videosDao.updateStatus(payload.userPayload.videoId, "virus");
 *           context.setPayload(
 *             payload.copy({
 *               workflowPayload: {
 *                 ...payload.workflowPayload,
 *                 stage: "done",
 *               },
 *             }).toJson,
 *           );
 *         } else {
 *           context.setPayload(
 *             payload.copy({
 *               workflowPayload: {
 *                 ...payload.workflowPayload,
 *                 stage: "encode",
 *               },
 *             }).toJson,
 *           );
 *           context.spawnChild({
 *             queue: "encode-video-file",
 *             payload: {
 *               videoId: payload.userPayload.videoId,
 *               path: payload.userPayload.sourcePath,
 *             },
 *           });
 *         }
 *         break;
 *       case "metadata":
 *         if (payload.userPayload.encodedPath) {
 *           const metadata = await this.transcoderBackend.readMetadata(
 *             payload.userPayload.encodedPath,
 *           );
 *           await this.videosDao.saveMetadata(payload.userPayload.videoId, metadata);
 *         }
 *         await this.videosDao.updateStatus(payload.userPayload.videoId, "ready");
 *         context.setPayload(
 *           payload.copy({
 *             workflowPayload: {
 *               ...payload.workflowPayload,
 *               stage: "done",
 *             },
 *           }).toJson,
 *         );
 *         break;
 *       case "encode":
 *       case "done":
 *         break;
 *     }
 *   }
 *
 *   protected override async childFinished(
 *     payload: MultiStepPayload<VideoPayload>,
 *     childTask: TaskStateSnapshot,
 *     context: TaskContext,
 *   ): Promise<void> {
 *     const stage = payload.workflowPayload["stage"] as VideoWorkflowPayload["stage"];
 *     switch (stage) {
 *       case "scan":
 *         context.setPayload(
 *           payload.copy({
 *             workflowPayload: {
 *               ...payload.workflowPayload,
 *               stage: "after-scan",
 *               virusesFound: childTask.result.map((r) => r["virusesFound"] === true).getOrElseValue(false),
 *             },
 *           }).toJson,
 *         );
 *         await this.processNext(
 *           payload.copy({
 *             workflowPayload: {
 *               ...payload.workflowPayload,
 *               stage: "after-scan",
 *               virusesFound: childTask.result.map((r) => r["virusesFound"] === true).getOrElseValue(false),
 *             },
 *           }),
 *           context,
 *         );
 *         break;
 *       case "encode": {
 *         const encodedPath = childTask.result.map((r) => String(r["encodedPath"])).getOrElseValue("");
 *         await this.videosDao.updateEncodedPath(payload.userPayload.videoId, encodedPath);
 *         const nextPayload = payload.copy({
 *           workflowPayload: {
 *             ...payload.workflowPayload,
 *             stage: "metadata",
 *           },
 *           userPayload: {
 *             ...payload.userPayload,
 *             encodedPath,
 *           },
 *         });
 *         context.setPayload(nextPayload.toJson);
 *         await this.processNext(nextPayload, context);
 *         break;
 *       }
 *       case "after-scan":
 *       case "metadata":
 *       case "done":
 *         await this.processNext(payload, context);
 *         break;
 *     }
 *   }
 * }
 * ```
 */
export abstract class MultiStepTask<
  TUserPayload extends object = Record<string, unknown>,
> extends TasksWorker {
  /**
   * Continue workflow processing after a child task has been loaded and verified to exist.
   *
   * The method clears `activeChildId` from payload, persists the cleaned payload through the context,
   * and dispatches control to the corresponding child-status hook.
   *
   * @param payload current parent payload
   * @param childTask loaded child task snapshot
   * @param context task runtime context
   */
  private async handleResolvedChild(
    payload: MultiStepPayload<TUserPayload>,
    activeChild: ActiveChildState,
    childTask: TaskStateSnapshot,
    context: TaskContext,
  ): Promise<void> {
    context.resolvedChildTask = some(childTask);
    const nextPayload = payload.copy({
      activeChild: none,
    });
    context.setPayload(nextPayload.toJson);
    if (childTask.status === TaskStatus.finished) {
      await this.childFinished(nextPayload, childTask, context, activeChild);
    } else if (childTask.status === TaskStatus.error) {
      await this.childFailed(nextPayload, childTask, context, activeChild);
    } else {
      throw new Error(
        `Active child task ${childTask.id} is not terminal: ${childTask.status}`,
      );
    }
  }

  /**
   * Process the next workflow step when there is no active child task.
   */
  protected abstract processNext(
    payload: MultiStepPayload<TUserPayload>,
    context: TaskContext,
  ): Promise<void>;

  /**
   * Called when the active child has finished successfully.
   *
   * Default behavior continues with the next workflow step.
   */
  protected async childFinished(
    payload: MultiStepPayload<TUserPayload>,
    _childTask: TaskStateSnapshot,
    context: TaskContext,
    _activeChild: ActiveChildState,
  ): Promise<void> {
    await this.processNext(payload, context);
  }

  /**
   * Called when the active child has reached terminal `error`.
   *
   * Default behavior fails the parent task.
   */
  protected async childFailed(
    payload: MultiStepPayload<TUserPayload>,
    childTask: { id: number; error?: string },
    _context: TaskContext,
    _activeChild: ActiveChildState,
  ): Promise<void> {
    throw new Error(
      `Child task ${childTask.id} failed: ${childTask.error ?? "Unknown error"}`,
    );
  }

  override async process(
    payload: unknown,
    context: TaskContext,
  ): Promise<void> {
    const typedPayload = MultiStepPayload.fromJson<TUserPayload>(payload);
    await typedPayload.activeChild.match({
      some: async (activeChild) => {
        const childTask = await context.findTask(activeChild.taskId);
        await childTask.match({
          some: async (task: TaskStateSnapshot) => {
            await this.handleResolvedChild(
              typedPayload,
              activeChild,
              task,
              context,
            );
          },
          none: async () => {
            throw new Error(
              `Active child task ${activeChild.taskId} not found`,
            );
          },
        });
      },
      none: async () => {
        await this.processNext(typedPayload, context);
      },
    });
  }
}
