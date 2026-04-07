import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { MultiStepPayload } from "../../src/multi-step-payload.js";
import { TaskStatus } from "../../src/tasks-model.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import {
  ReadVideoMetadataWorker,
  SequentialVideoWithLocalStepWorker,
  UploadVideoWorker,
  VIDEO_METADATA_QUEUE,
  VIDEO_PARENT_LOCAL_STEP_QUEUE,
  VIDEO_UPLOAD_QUEUE,
} from "./support/video-test-workers.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Sequential local-step integration", () => {
  const test = new QueueIntegrationTest();

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_LOCAL_STEP_QUEUE,
      new SequentialVideoWithLocalStepWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_UPLOAD_QUEUE,
      new UploadVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_METADATA_QUEUE,
      new ReadVideoMetadataWorker(),
    );
  });

  beforeEach(async () => {
    await test.reset();
  });

  afterAll(async () => {
    await test.stop();
  });

  it("persists parent payload through a local step before blocking on the next child", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_LOCAL_STEP_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-local-42" })
        .toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // First parent pass: spawn upload child.
    await test.tasksQueueService.runOnce();

    const blockedAfterUploadSpawn = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedAfterUploadSpawn.isDefined).toBe(true);
    expect(blockedAfterUploadSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedAfterUploadSpawn.get.payload).toMatchObject({
      workflowPayload: {
        step: "upload",
      },
      userPayload: {
        videoId: "vid-local-42",
      },
      activeChild: {
        taskId: expect.any(Number),
      },
    });

    const uploadTaskId = Number(
      (blockedAfterUploadSpawn.get.payload as Record<string, any>)[
        "activeChild"
      ]["taskId"],
    );

    // Upload child finishes and wakes parent.
    await test.tasksQueueService.runOnce();

    const finishedUploadTask =
      await test.manageTasksQueueService.findById(uploadTaskId);
    expect(finishedUploadTask.isDefined).toBe(true);
    expect(finishedUploadTask.get.status).toBe(TaskStatus.finished);
    expect(finishedUploadTask.get.result).toEqual({
      videoId: "vid-local-42",
      path: "/videos/vid-local-42.mp4",
    });

    const pendingParentForLocalStep =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentForLocalStep.isDefined).toBe(true);
    expect(pendingParentForLocalStep.get.status).toBe(TaskStatus.pending);

    // Second parent pass: local prepare step updates payload, then metadata step
    // auto-continues in the same execution and spawns metadata child.
    await test.tasksQueueService.runOnce();

    const blockedAfterMetadataSpawn =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedAfterMetadataSpawn.isDefined).toBe(true);
    expect(blockedAfterMetadataSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedAfterMetadataSpawn.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-local-42",
        uploadResult: {
          videoId: "vid-local-42",
          path: "/videos/vid-local-42.mp4",
        },
      },
      activeChild: {
        taskId: expect.any(Number),
      },
    });

    const metadataTaskId = Number(
      (blockedAfterMetadataSpawn.get.payload as Record<string, any>)[
        "activeChild"
      ]["taskId"],
    );

    const metadataTask =
      await test.manageTasksQueueService.findById(metadataTaskId);
    expect(metadataTask.isDefined).toBe(true);
    expect(metadataTask.get.status).toBe(TaskStatus.pending);
    expect(metadataTask.get.parentId.orUndefined).toBe(parentTaskId.get);
    expect(metadataTask.get.payload).toEqual({
      path: "/videos/vid-local-42.mp4",
    });

    // Metadata child finishes, then final parent pass aggregates final output.
    await test.tasksQueueService.runOnce();
    await test.tasksQueueService.runOnce();

    const finishedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(finishedParent.isDefined).toBe(true);
    expect(finishedParent.get.status).toBe(TaskStatus.finished);
    expect(finishedParent.get.payload).toEqual({
      workflowPayload: {
        step: "aggregate",
      },
      userPayload: {
        videoId: "vid-local-42",
        uploadResult: {
          videoId: "vid-local-42",
          path: "/videos/vid-local-42.mp4",
        },
        metadataResult: {
          path: "/videos/vid-local-42.mp4",
          durationSec: 120,
          width: 1920,
          height: 1080,
        },
      },
    });
    expect(finishedParent.get.result).toEqual({
      videoId: "vid-local-42",
      upload: {
        videoId: "vid-local-42",
        path: "/videos/vid-local-42.mp4",
      },
      metadata: {
        path: "/videos/vid-local-42.mp4",
        durationSec: 120,
        width: 1920,
        height: 1080,
      },
    });
  });
});
