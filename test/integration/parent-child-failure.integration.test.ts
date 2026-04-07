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
import { TimeUtils } from "../../src/time-utils.js";
import { BaseIntegrationTest } from "./base-integration-test.js";
import { ControlledTestWorker } from "./support/controlled-test-worker.js";
import { ManualClock } from "./support/manual-clock.js";
import { TestTaskEventsBus } from "./support/task-events-bus.js";
import {
  SequentialTaskFailedVideoWorker,
  SequentialAllowFailureVideoWorker,
  SequentialFailingVideoWorker,
  SequentialParentCrashAfterWakeWorker,
  SequentialSecondChildAllowFailureVideoWorker,
  SequentialSecondChildFailingVideoWorker,
  SequentialStalledChildVideoWorker,
  TaskFailedUploadWorker,
  UploadVideoWorker,
  VIDEO_FAILING_UPLOAD_QUEUE,
  VIDEO_PARENT_ALLOW_FAILURE_QUEUE,
  VIDEO_PARENT_FAILURE_QUEUE,
  VIDEO_PARENT_QUEUE,
  VIDEO_PARENT_POST_CHILD_CRASH_QUEUE,
  VIDEO_PARENT_TASK_FAILED_QUEUE,
  VIDEO_PARENT_SECOND_CHILD_ALLOW_FAILURE_QUEUE,
  VIDEO_PARENT_SECOND_CHILD_FAILURE_QUEUE,
  VIDEO_PARENT_STALLED_CHILD_QUEUE,
  VIDEO_TASK_FAILED_UPLOAD_QUEUE,
  VIDEO_UPLOAD_QUEUE,
  SequentialVideoWorker,
} from "./support/video-test-workers.js";

class QueueIntegrationTest extends BaseIntegrationTest {}

describe("Parent-child failure integration", () => {
  const baseTime = new Date("2026-04-07T10:00:00.000Z");
  const clock = new ManualClock(baseTime);
  const test = new QueueIntegrationTest(clock);
  const bus = new TestTaskEventsBus();
  const failingChildWorker = new ControlledTestWorker(bus);

  beforeAll(async () => {
    await test.start();
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_FAILURE_QUEUE,
      new SequentialFailingVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_ALLOW_FAILURE_QUEUE,
      new SequentialAllowFailureVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_SECOND_CHILD_FAILURE_QUEUE,
      new SequentialSecondChildFailingVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_SECOND_CHILD_ALLOW_FAILURE_QUEUE,
      new SequentialSecondChildAllowFailureVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_STALLED_CHILD_QUEUE,
      new SequentialStalledChildVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_POST_CHILD_CRASH_QUEUE,
      new SequentialParentCrashAfterWakeWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_TASK_FAILED_QUEUE,
      new SequentialTaskFailedVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_PARENT_QUEUE,
      new SequentialVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_UPLOAD_QUEUE,
      new UploadVideoWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_TASK_FAILED_UPLOAD_QUEUE,
      new TaskFailedUploadWorker(),
    );
    test.tasksQueueService.registerWorker(
      VIDEO_FAILING_UPLOAD_QUEUE,
      failingChildWorker,
    );
  });

  beforeEach(async () => {
    await test.reset();
    bus.reset();
    failingChildWorker.reset();
    clock.set(baseTime);
  });

  afterAll(async () => {
    await test.stop();
  });

  it("keeps parent blocked while child retries and fails parent after terminal child error", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_FAILURE_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-99" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it spawns retryable child and moves to blocked state.
    await test.tasksQueueService.runOnce();

    // Confirm that parent is blocked on the child and has not consumed its own attempt budget.
    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    expect(blockedParent.get.attempt).toBe(0);

    const childTaskId = Number(
      (blockedParent.get.payload as Record<string, any>)["activeChild"][
        "taskId"
      ],
    );

    // Start the child and fail the first attempt; retries are still available.
    const firstChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId);
    failingChildWorker.fail(childTaskId, new Error("boom"));
    await bus.waitForFailed(childTaskId);
    await firstChildRunPromise;

    // Validate that child was re-queued for retry while the parent remained blocked.
    const retryingChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(retryingChild.isDefined).toBe(true);
    expect(retryingChild.get.status).toBe(TaskStatus.pending);
    expect(retryingChild.get.attempt).toBe(1);
    expect(retryingChild.get.error.orUndefined).toBe("boom");
    expect(retryingChild.get.startAfter.orUndefined).toEqual(
      new Date(baseTime.getTime() + TimeUtils.minute),
    );

    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);
    expect(stillBlockedParent.get.attempt).toBe(0);

    // Poll before backoff expires; neither child retry nor parent wake-up should happen yet.
    await test.tasksQueueService.runOnce();

    const blockedParentBeforeRetry =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedParentBeforeRetry.isDefined).toBe(true);
    expect(blockedParentBeforeRetry.get.status).toBe(TaskStatus.blocked);
    expect(blockedParentBeforeRetry.get.attempt).toBe(0);

    // Advance past backoff and fail the second child attempt terminally.
    clock.advance(TimeUtils.minute + 1);
    const secondChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId, 2);
    failingChildWorker.fail(childTaskId, new Error("boom"));
    await bus.waitForFailed(childTaskId, 2);
    await secondChildRunPromise;

    // Confirm that child is now terminally failed and parent has been woken back to pending.
    const failedChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(failedChild.isDefined).toBe(true);
    expect(failedChild.get.status).toBe(TaskStatus.error);
    expect(failedChild.get.attempt).toBe(2);
    expect(failedChild.get.error.orUndefined).toBe("boom");

    const pendingParentAfterChildError =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterChildError.isDefined).toBe(true);
    expect(pendingParentAfterChildError.get.status).toBe(TaskStatus.pending);
    expect(pendingParentAfterChildError.get.attempt).toBe(0);

    // Run the resumed parent; default SequentialTask behavior should fail it on child terminal error.
    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe(
      `Child task ${childTaskId} failed: boom`,
    );
  });

  it("keeps parent blocked while child retries and then continues when allowFailure is enabled", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_ALLOW_FAILURE_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-100" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it spawns an allow-failure child and moves to blocked state.
    await test.tasksQueueService.runOnce();

    // Confirm that parent is blocked on the child and has not consumed its own attempt budget.
    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    expect(blockedParent.get.attempt).toBe(0);

    const childTaskId = Number(
      (blockedParent.get.payload as Record<string, any>)["activeChild"][
        "taskId"
      ],
    );

    // Fail the first child attempt; retries are still available so parent must remain blocked.
    const firstChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId);
    failingChildWorker.fail(childTaskId, new Error("boom"));
    await bus.waitForFailed(childTaskId);
    await firstChildRunPromise;

    const retryingChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(retryingChild.isDefined).toBe(true);
    expect(retryingChild.get.status).toBe(TaskStatus.pending);
    expect(retryingChild.get.attempt).toBe(1);
    expect(retryingChild.get.error.orUndefined).toBe("boom");

    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);
    expect(stillBlockedParent.get.attempt).toBe(0);

    // Advance past backoff and fail child terminally; parent should wake but not fail.
    clock.advance(TimeUtils.minute + 1);
    const secondChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId, 2);
    failingChildWorker.fail(childTaskId, new Error("boom"));
    await bus.waitForFailed(childTaskId, 2);
    await secondChildRunPromise;

    const failedChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(failedChild.isDefined).toBe(true);
    expect(failedChild.get.status).toBe(TaskStatus.error);
    expect(failedChild.get.attempt).toBe(2);
    expect(failedChild.get.error.orUndefined).toBe("boom");

    // Parent should wake to pending and remain ready to continue with the next step.
    const pendingParentAfterChildError =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterChildError.isDefined).toBe(true);
    expect(pendingParentAfterChildError.get.status).toBe(TaskStatus.pending);
    expect(pendingParentAfterChildError.get.attempt).toBe(0);

    // Run resumed parent; allowFailure should let workflow continue and finish successfully.
    await test.tasksQueueService.runOnce();

    const finishedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(finishedParent.isDefined).toBe(true);
    expect(finishedParent.get.status).toBe(TaskStatus.finished);
    expect(finishedParent.get.attempt).toBe(1);
    expect(finishedParent.get.payload).toEqual({
      workflowPayload: {
        step: "aggregate",
      },
      userPayload: {
        videoId: "vid-100",
        childStatus: TaskStatus.error,
        childError: "boom",
      },
    });
    expect(finishedParent.get.result).toEqual({
      videoId: "vid-100",
      childStatus: TaskStatus.error,
      childError: "boom",
    });
  });

  it("keeps parent blocked while second child retries and fails parent after terminal second-child error", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_SECOND_CHILD_FAILURE_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-101" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it spawns the first successful child.
    await test.tasksQueueService.runOnce();

    const blockedParentAfterFirstSpawn =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedParentAfterFirstSpawn.isDefined).toBe(true);
    expect(blockedParentAfterFirstSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedParentAfterFirstSpawn.get.attempt).toBe(0);

    const firstChildTaskId = Number(
      (blockedParentAfterFirstSpawn.get.payload as Record<string, any>)[
        "activeChild"
      ]["taskId"],
    );

    // Run the first child to successful completion so parent can proceed to the second step.
    await test.tasksQueueService.runOnce();

    const finishedFirstChild =
      await test.manageTasksQueueService.findById(firstChildTaskId);
    expect(finishedFirstChild.isDefined).toBe(true);
    expect(finishedFirstChild.get.status).toBe(TaskStatus.finished);
    expect(finishedFirstChild.get.attempt).toBe(1);
    expect(finishedFirstChild.get.result).toEqual({
      videoId: "vid-101",
      path: "/videos/vid-101.mp4",
    });

    const pendingParentForSecondChild =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentForSecondChild.isDefined).toBe(true);
    expect(pendingParentForSecondChild.get.status).toBe(TaskStatus.pending);
    expect(pendingParentForSecondChild.get.attempt).toBe(0);

    // Run parent again so it stores first-child result and spawns retryable second child.
    await test.tasksQueueService.runOnce();

    const blockedParentAfterSecondSpawn =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedParentAfterSecondSpawn.isDefined).toBe(true);
    expect(blockedParentAfterSecondSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedParentAfterSecondSpawn.get.attempt).toBe(0);
    expect(blockedParentAfterSecondSpawn.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-101",
        uploadResult: {
          videoId: "vid-101",
          path: "/videos/vid-101.mp4",
        },
      },
      activeChild: {
        taskId: expect.any(Number),
      },
    });

    const secondChildTaskId = Number(
      (blockedParentAfterSecondSpawn.get.payload as Record<string, any>)[
        "activeChild"
      ]["taskId"],
    );
    const secondChildBeforeRun =
      await test.manageTasksQueueService.findById(secondChildTaskId);
    expect(secondChildBeforeRun.isDefined).toBe(true);
    expect(secondChildBeforeRun.get.status).toBe(TaskStatus.pending);
    expect(secondChildBeforeRun.get.attempt).toBe(0);
    expect(secondChildBeforeRun.get.payload).toEqual({
      path: "/videos/vid-101.mp4",
    });

    // Fail the first second-child attempt; parent must stay blocked while child retries.
    const firstSecondChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(secondChildTaskId);
    failingChildWorker.fail(secondChildTaskId, new Error("boom"));
    await bus.waitForFailed(secondChildTaskId);
    await firstSecondChildRunPromise;

    const retryingSecondChild =
      await test.manageTasksQueueService.findById(secondChildTaskId);
    expect(retryingSecondChild.isDefined).toBe(true);
    expect(retryingSecondChild.get.status).toBe(TaskStatus.pending);
    expect(retryingSecondChild.get.attempt).toBe(1);
    expect(retryingSecondChild.get.error.orUndefined).toBe("boom");
    expect(retryingSecondChild.get.startAfter.orUndefined).toEqual(
      new Date(baseTime.getTime() + TimeUtils.minute),
    );

    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);
    expect(stillBlockedParent.get.attempt).toBe(0);
    expect(stillBlockedParent.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-101",
        uploadResult: {
          videoId: "vid-101",
          path: "/videos/vid-101.mp4",
        },
      },
      activeChild: {
        taskId: secondChildTaskId,
      },
    });

    // Advance past backoff and fail the second child attempt terminally.
    clock.advance(TimeUtils.minute + 1);
    const secondSecondChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(secondChildTaskId, 2);
    failingChildWorker.fail(secondChildTaskId, new Error("boom"));
    await bus.waitForFailed(secondChildTaskId, 2);
    await secondSecondChildRunPromise;

    const failedSecondChild =
      await test.manageTasksQueueService.findById(secondChildTaskId);
    expect(failedSecondChild.isDefined).toBe(true);
    expect(failedSecondChild.get.status).toBe(TaskStatus.error);
    expect(failedSecondChild.get.attempt).toBe(2);
    expect(failedSecondChild.get.error.orUndefined).toBe("boom");

    const pendingParentAfterSecondChildError =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterSecondChildError.isDefined).toBe(true);
    expect(pendingParentAfterSecondChildError.get.status).toBe(
      TaskStatus.pending,
    );
    expect(pendingParentAfterSecondChildError.get.attempt).toBe(0);
    expect(pendingParentAfterSecondChildError.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-101",
        uploadResult: {
          videoId: "vid-101",
          path: "/videos/vid-101.mp4",
        },
      },
      activeChild: {
        taskId: secondChildTaskId,
      },
    });

    // Run the resumed parent; default behavior should now fail parent on the terminal second-child error.
    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe(
      `Child task ${secondChildTaskId} failed: boom`,
    );
    expect(failedParent.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-101",
        uploadResult: {
          videoId: "vid-101",
          path: "/videos/vid-101.mp4",
        },
      },
      activeChild: {
        taskId: secondChildTaskId,
      },
    });
  });

  it("keeps parent blocked while second child retries and then continues when second child allows failure", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_SECOND_CHILD_ALLOW_FAILURE_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-102" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it spawns the first successful child.
    await test.tasksQueueService.runOnce();

    const blockedParentAfterFirstSpawn =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedParentAfterFirstSpawn.isDefined).toBe(true);
    expect(blockedParentAfterFirstSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedParentAfterFirstSpawn.get.attempt).toBe(0);

    const firstChildTaskId = Number(
      (blockedParentAfterFirstSpawn.get.payload as Record<string, any>)[
        "activeChild"
      ]["taskId"],
    );

    // Complete the first child so parent can move to the second step.
    await test.tasksQueueService.runOnce();

    const finishedFirstChild =
      await test.manageTasksQueueService.findById(firstChildTaskId);
    expect(finishedFirstChild.isDefined).toBe(true);
    expect(finishedFirstChild.get.status).toBe(TaskStatus.finished);
    expect(finishedFirstChild.get.attempt).toBe(1);
    expect(finishedFirstChild.get.result).toEqual({
      videoId: "vid-102",
      path: "/videos/vid-102.mp4",
    });

    // Resume parent so it persists first-child result and spawns allow-failure second child.
    await test.tasksQueueService.runOnce();

    const blockedParentAfterSecondSpawn =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(blockedParentAfterSecondSpawn.isDefined).toBe(true);
    expect(blockedParentAfterSecondSpawn.get.status).toBe(TaskStatus.blocked);
    expect(blockedParentAfterSecondSpawn.get.attempt).toBe(0);
    expect(blockedParentAfterSecondSpawn.get.payload).toEqual({
      workflowPayload: {
        step: "metadata",
      },
      userPayload: {
        videoId: "vid-102",
        uploadResult: {
          videoId: "vid-102",
          path: "/videos/vid-102.mp4",
        },
      },
      activeChild: {
        taskId: expect.any(Number),
        allowFailure: true,
      },
    });

    const secondChildTaskId = Number(
      (blockedParentAfterSecondSpawn.get.payload as Record<string, any>)[
        "activeChild"
      ]["taskId"],
    );

    // Fail the first second-child attempt; parent must remain blocked while child retries.
    const firstSecondChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(secondChildTaskId);
    failingChildWorker.fail(secondChildTaskId, new Error("boom"));
    await bus.waitForFailed(secondChildTaskId);
    await firstSecondChildRunPromise;

    const retryingSecondChild =
      await test.manageTasksQueueService.findById(secondChildTaskId);
    expect(retryingSecondChild.isDefined).toBe(true);
    expect(retryingSecondChild.get.status).toBe(TaskStatus.pending);
    expect(retryingSecondChild.get.attempt).toBe(1);
    expect(retryingSecondChild.get.error.orUndefined).toBe("boom");

    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);
    expect(stillBlockedParent.get.attempt).toBe(0);

    // Advance past backoff and fail the second child attempt terminally.
    clock.advance(TimeUtils.minute + 1);
    const secondSecondChildRunPromise = test.tasksQueueService.runOnce();
    await bus.waitForStarted(secondChildTaskId, 2);
    failingChildWorker.fail(secondChildTaskId, new Error("boom"));
    await bus.waitForFailed(secondChildTaskId, 2);
    await secondSecondChildRunPromise;

    const failedSecondChild =
      await test.manageTasksQueueService.findById(secondChildTaskId);
    expect(failedSecondChild.isDefined).toBe(true);
    expect(failedSecondChild.get.status).toBe(TaskStatus.error);
    expect(failedSecondChild.get.attempt).toBe(2);
    expect(failedSecondChild.get.error.orUndefined).toBe("boom");

    const pendingParentAfterSecondChildError =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterSecondChildError.isDefined).toBe(true);
    expect(pendingParentAfterSecondChildError.get.status).toBe(
      TaskStatus.pending,
    );
    expect(pendingParentAfterSecondChildError.get.attempt).toBe(0);

    // Run resumed parent; allowFailure should let the workflow finish and capture child error details.
    await test.tasksQueueService.runOnce();

    const finishedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(finishedParent.isDefined).toBe(true);
    expect(finishedParent.get.status).toBe(TaskStatus.finished);
    expect(finishedParent.get.attempt).toBe(1);
    expect(finishedParent.get.payload).toEqual({
      workflowPayload: {
        step: "aggregate",
      },
      userPayload: {
        videoId: "vid-102",
        uploadResult: {
          videoId: "vid-102",
          path: "/videos/vid-102.mp4",
        },
        childStatus: TaskStatus.error,
        childError: "boom",
      },
    });
    expect(finishedParent.get.result).toEqual({
      videoId: "vid-102",
      upload: {
        videoId: "vid-102",
        path: "/videos/vid-102.mp4",
      },
      childStatus: TaskStatus.error,
      childError: "boom",
    });
  });

  it("keeps parent blocked on retryable child timeout and wakes parent after terminal timeout", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_STALLED_CHILD_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-103" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run parent once so it spawns a child with timeout and enters blocked state.
    await test.tasksQueueService.runOnce();

    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    expect(blockedParent.get.attempt).toBe(0);

    const childTaskId = Number(
      (blockedParent.get.payload as Record<string, any>)["activeChild"][
        "taskId"
      ],
    );

    // Start the child and leave it hanging so timeout detection drives the transition.
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId);

    // Move past timeout and mark stalled tasks; child should retry and parent should stay blocked.
    clock.advance(TimeUtils.second + 1);
    const firstStalled = await test.tasksQueueDao.failStalled(clock.now());
    expect(firstStalled.toArray).toEqual([childTaskId]);

    const retryingChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(retryingChild.isDefined).toBe(true);
    expect(retryingChild.get.status).toBe(TaskStatus.pending);
    expect(retryingChild.get.attempt).toBe(1);
    expect(retryingChild.get.error.orUndefined).toBe("Timeout");
    expect(retryingChild.get.startAfter.orUndefined).toEqual(
      new Date(baseTime.getTime() + TimeUtils.second + 1 + TimeUtils.minute),
    );

    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);
    expect(stillBlockedParent.get.attempt).toBe(0);

    // Advance past backoff, start the retry attempt, and leave it hanging again.
    clock.advance(TimeUtils.minute + 1);
    void test.tasksQueueService.runOnce();
    await bus.waitForStarted(childTaskId, 2);

    // Move past timeout again; terminal child timeout should wake parent back to pending.
    clock.advance(TimeUtils.second + 1);
    const secondStalled = await test.tasksQueueDao.failStalled(clock.now());
    expect(secondStalled.toArray).toEqual([childTaskId]);

    const failedChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(failedChild.isDefined).toBe(true);
    expect(failedChild.get.status).toBe(TaskStatus.error);
    expect(failedChild.get.attempt).toBe(2);
    expect(failedChild.get.error.orUndefined).toBe("Timeout");

    const pendingParentAfterTimeout =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterTimeout.isDefined).toBe(true);
    expect(pendingParentAfterTimeout.get.status).toBe(TaskStatus.pending);
    expect(pendingParentAfterTimeout.get.attempt).toBe(0);

    // Resume parent; default behavior should fail it on terminal child timeout.
    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe(
      `Child task ${childTaskId} failed: Timeout`,
    );
  });

  it("fails parent when parent crashes after waking up from a successful child", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_POST_CHILD_CRASH_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-104" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it spawns the successful child and enters blocked state.
    await test.tasksQueueService.runOnce();

    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    expect(blockedParent.get.attempt).toBe(0);

    const childTaskId = Number(
      (blockedParent.get.payload as Record<string, any>)["activeChild"][
        "taskId"
      ],
    );

    // Run the child to successful completion so parent wakes up for the next step.
    await test.tasksQueueService.runOnce();

    const finishedChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(finishedChild.isDefined).toBe(true);
    expect(finishedChild.get.status).toBe(TaskStatus.finished);
    expect(finishedChild.get.attempt).toBe(1);
    expect(finishedChild.get.result).toEqual({
      videoId: "vid-104",
      path: "/videos/vid-104.mp4",
    });

    const pendingParentAfterChildSuccess =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterChildSuccess.isDefined).toBe(true);
    expect(pendingParentAfterChildSuccess.get.status).toBe(TaskStatus.pending);
    expect(pendingParentAfterChildSuccess.get.attempt).toBe(0);

    // Resume the parent; the next step should crash inside the parent itself.
    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe("Parent post-child crash");

    // Current error-path semantics preserve the last persisted runtime payload snapshot.
    expect(failedParent.get.payload).toEqual({
      workflowPayload: {
        step: "upload",
      },
      userPayload: {
        videoId: "vid-104",
      },
      activeChild: {
        taskId: childTaskId,
      },
    });
  });

  it("keeps parent blocked while child retries with TaskFailed payload replacement and then finishes successfully", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_TASK_FAILED_QUEUE,
      payload: MultiStepPayload.forUserPayload({ videoId: "vid-105" }).toJson,
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent once so it spawns a retryable child and enters blocked state.
    await test.tasksQueueService.runOnce();

    const blockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(blockedParent.isDefined).toBe(true);
    expect(blockedParent.get.status).toBe(TaskStatus.blocked);
    expect(blockedParent.get.attempt).toBe(0);

    const childTaskId = Number(
      (blockedParent.get.payload as Record<string, any>)["activeChild"][
        "taskId"
      ],
    );

    // Run the child once; it should throw TaskFailed and replace its payload for retry.
    await test.tasksQueueService.runOnce();

    const retryingChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(retryingChild.isDefined).toBe(true);
    expect(retryingChild.get.status).toBe(TaskStatus.pending);
    expect(retryingChild.get.attempt).toBe(1);
    expect(retryingChild.get.error.orUndefined).toBe("Upload retry requested");
    expect(retryingChild.get.payload).toEqual({
      videoId: "vid-105",
      retryPath: "/videos/vid-105.retry.mp4",
    });
    expect(retryingChild.get.startAfter.orUndefined).toEqual(
      new Date(baseTime.getTime() + TimeUtils.minute),
    );

    const stillBlockedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(stillBlockedParent.isDefined).toBe(true);
    expect(stillBlockedParent.get.status).toBe(TaskStatus.blocked);
    expect(stillBlockedParent.get.attempt).toBe(0);

    // Advance past backoff and rerun the child; it should now succeed using the replaced payload.
    clock.advance(TimeUtils.minute + 1);
    await test.tasksQueueService.runOnce();

    const finishedChild =
      await test.manageTasksQueueService.findById(childTaskId);
    expect(finishedChild.isDefined).toBe(true);
    expect(finishedChild.get.status).toBe(TaskStatus.finished);
    expect(finishedChild.get.attempt).toBe(2);
    expect(finishedChild.get.payload).toEqual({
      videoId: "vid-105",
      retryPath: "/videos/vid-105.retry.mp4",
    });
    expect(finishedChild.get.result).toEqual({
      videoId: "vid-105",
      path: "/videos/vid-105.retry.mp4",
      retried: true,
    });

    const pendingParentAfterChildSuccess =
      await test.manageTasksQueueService.findById(parentTaskId.get);
    expect(pendingParentAfterChildSuccess.isDefined).toBe(true);
    expect(pendingParentAfterChildSuccess.get.status).toBe(TaskStatus.pending);
    expect(pendingParentAfterChildSuccess.get.attempt).toBe(0);

    // Resume parent; it should consume the child result and finish successfully.
    await test.tasksQueueService.runOnce();

    const finishedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(finishedParent.isDefined).toBe(true);
    expect(finishedParent.get.status).toBe(TaskStatus.finished);
    expect(finishedParent.get.attempt).toBe(1);
    expect(finishedParent.get.payload).toEqual({
      workflowPayload: {
        step: "aggregate",
      },
      userPayload: {
        videoId: "vid-105",
        childResult: {
          videoId: "vid-105",
          path: "/videos/vid-105.retry.mp4",
          retried: true,
        },
      },
    });
    expect(finishedParent.get.result).toEqual({
      videoId: "vid-105",
      child: {
        videoId: "vid-105",
        path: "/videos/vid-105.retry.mp4",
        retried: true,
      },
    });
  });

  it("fails parent with explicit error when active child reference points to missing task", async () => {
    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_QUEUE,
      payload: {
        workflowPayload: {
          step: "upload",
        },
        userPayload: {
          videoId: "vid-106",
        },
        activeChild: {
          taskId: 999_999,
        },
      },
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent with a broken activeChild reference; resume should fail immediately.
    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe(
      "Child task with id=999999 not found",
    );
    expect(failedParent.get.payload).toEqual({
      workflowPayload: {
        step: "upload",
      },
      userPayload: {
        videoId: "vid-106",
      },
      activeChild: {
        taskId: 999_999,
      },
    });
  });

  it("fails parent with explicit inconsistency error when active child is not terminal on wake-up", async () => {
    const childTaskId = await test.tasksQueueService.schedule({
      queue: "orphan-pending-child",
      payload: {
        videoId: "vid-107",
      },
    });

    expect(childTaskId.isDefined).toBe(true);

    const parentTaskId = await test.tasksQueueService.schedule({
      queue: VIDEO_PARENT_QUEUE,
      payload: {
        workflowPayload: {
          step: "upload",
        },
        userPayload: {
          videoId: "vid-107",
        },
        activeChild: {
          taskId: childTaskId.get,
        },
      },
    });

    expect(parentTaskId.isDefined).toBe(true);

    // Run the parent with an existing but non-terminal child reference; resume should fail explicitly.
    await test.tasksQueueService.runOnce();

    const failedParent = await test.manageTasksQueueService.findById(
      parentTaskId.get,
    );
    expect(failedParent.isDefined).toBe(true);
    expect(failedParent.get.status).toBe(TaskStatus.error);
    expect(failedParent.get.attempt).toBe(1);
    expect(failedParent.get.error.orUndefined).toBe(
      `Inconsistent workflow state: child task with id=${childTaskId.get} is not terminal (status=pending)`,
    );
    expect(failedParent.get.payload).toEqual({
      workflowPayload: {
        step: "upload",
      },
      userPayload: {
        videoId: "vid-107",
      },
      activeChild: {
        taskId: childTaskId.get,
      },
    });
  });
});
