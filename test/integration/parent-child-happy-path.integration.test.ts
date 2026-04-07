import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { MultiStepPayload } from "../../src/multi-step-payload.js";
import { TaskStatus } from "../../src/tasks-model.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import {
  ReadVideoMetadataWorker,
  SequentialVideoWorker,
  UploadVideoWorker,
  VIDEO_METADATA_QUEUE,
  VIDEO_PARENT_QUEUE,
  VIDEO_UPLOAD_QUEUE,
} from "./support/video-test-workers.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Parent-child happy path integration", () => {
  const test = new QueueIntegrationTest();

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker(VIDEO_PARENT_QUEUE, new SequentialVideoWorker());
    test.tasksQueueService.registerWorker(VIDEO_UPLOAD_QUEUE, new UploadVideoWorker());
    test.tasksQueueService.registerWorker(VIDEO_METADATA_QUEUE, new ReadVideoMetadataWorker());
  });

  beforeEach(async () => {
    await test.reset();
  });

  afterAll(async () => {
    await test.stop();
  });

  it("passes results across two child tasks and aggregates the final parent result", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-42" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it enters the first sequential step and spawns upload child.
    await test.tasksQueueService.runOnce();

    // Reload parent and verify that it is blocked on the upload child without consuming attempts.
    const blockedAfterUploadSpawn = await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedAfterUploadSpawn.isDefined).toBe(true);
    expect(blockedAfterUploadSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedAfterUploadSpawn.get.attempt).toBe(0);
    expect(blockedAfterUploadSpawn.get.payload).toMatchObject({
      workflowPayload: {
        step: "upload",
      },
      userPayload: {
        videoId: "vid-42",
      },
      activeChild: {
        taskId: expect.any(Number),
      },
    });

    const uploadTaskId = Number(
      (blockedAfterUploadSpawn.get.payload as Record<string, any>)["activeChild"]["taskId"],
    );

    // Load the newly created upload child and confirm that it received the expected input payload.
    const uploadTask = await test.manageTasksQueueService.findById(uploadTaskId);
    expect(uploadTask.isDefined).toBe(true);
    expect(uploadTask.get.attempt).toBe(0);
    expect(uploadTask.get.parentId.orUndefined).toBe(parentTaskId.get);
    expect(uploadTask.get.payload).toEqual({
      videoId: "vid-42",
    });

    // Execute the upload child; this should finish the child and wake parent back to pending.
    await test.tasksQueueService.runOnce();

    // Validate the upload result because the next parent step must pass its path downstream.
    const finishedUploadTask = await test.manageTasksQueueService.findById(uploadTaskId);
    expect(finishedUploadTask.isDefined).toBe(true);
    expect(finishedUploadTask.get.attempt).toBe(1);
    expect(finishedUploadTask.get.status).toBe(TaskStatus.finished);
    expect(finishedUploadTask.get.result).toEqual({
      videoId: "vid-42",
      path: "/videos/vid-42.mp4",
    });

    // Fetch the parent again and confirm it was re-queued for the next sequential step.
    const pendingParentForMetadata = await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentForMetadata.isDefined).toBe(true);
    expect(pendingParentForMetadata.get.status).toBe(TaskStatus.pending);
    expect(pendingParentForMetadata.get.attempt).toBe(0);

    // Run the resumed parent so it stores upload result and spawns metadata child.
    await test.tasksQueueService.runOnce();

    // Verify that the resumed parent persisted upload output before blocking on metadata child.
    const blockedAfterMetadataSpawn = await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedAfterMetadataSpawn.isDefined).toBe(true);
    expect(blockedAfterMetadataSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedAfterMetadataSpawn.get.attempt).toBe(0);
    expect(blockedAfterMetadataSpawn.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-42",
        uploadResult: {
          videoId: "vid-42",
          path: "/videos/vid-42.mp4",
        },
      },
      activeChild: {
        taskId: expect.any(Number),
      },
    });

    const metadataTaskId = Number(
      (blockedAfterMetadataSpawn.get.payload as Record<string, any>)["activeChild"]["taskId"],
    );

    // Inspect metadata child and confirm it received the path returned by upload step.
    const metadataTask = await test.manageTasksQueueService.findById(metadataTaskId);
    expect(metadataTask.isDefined).toBe(true);
    expect(metadataTask.get.attempt).toBe(0);
    expect(metadataTask.get.parentId.orUndefined).toBe(parentTaskId.get);
    expect(metadataTask.get.payload).toEqual({
      path: "/videos/vid-42.mp4",
    });

    // Execute metadata child; this should persist metadata result and wake parent again.
    await test.tasksQueueService.runOnce();

    // Validate metadata output because the parent should aggregate it in the final step.
    const finishedMetadataTask = await test.manageTasksQueueService.findById(metadataTaskId);
    expect(finishedMetadataTask.isDefined).toBe(true);
    expect(finishedMetadataTask.get.attempt).toBe(1);
    expect(finishedMetadataTask.get.status).toBe(TaskStatus.finished);
    expect(finishedMetadataTask.get.result).toEqual({
      path: "/videos/vid-42.mp4",
      durationSec: 120,
      width: 1920,
      height: 1080,
    });

    // Fetch updated parent details and validate that it moved back to pending without spending attempts.
    const pendingParentForAggregation = await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentForAggregation.isDefined).toBe(true);
    expect(pendingParentForAggregation.get.status).toBe(TaskStatus.pending);
    expect(pendingParentForAggregation.get.attempt).toBe(0);

    // Trigger the final parent pass; this should aggregate both child results and finish the workflow.
    await test.tasksQueueService.runOnce();

    // Verify final parent payload and result contain everything collected from both children.
    const finishedParent = await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(finishedParent.isDefined).toBe(true);
    expect(finishedParent.get.status).toBe(TaskStatus.finished);
    expect(finishedParent.get.attempt).toBe(1);
    expect(finishedParent.get.payload).toEqual({
      workflowPayload: {
        step: "aggregate",
      },
      userPayload: {
        videoId: "vid-42",
        uploadResult: {
          videoId: "vid-42",
          path: "/videos/vid-42.mp4",
        },
        metadataResult: {
          path: "/videos/vid-42.mp4",
          durationSec: 120,
          width: 1920,
          height: 1080,
        },
      },
    });
    expect(finishedParent.get.result).toEqual({
      videoId: "vid-42",
      upload: {
        videoId: "vid-42",
        path: "/videos/vid-42.mp4",
      },
      metadata: {
        path: "/videos/vid-42.mp4",
        durationSec: 120,
        width: 1920,
        height: 1080,
      },
    });
  });
});
