import { describe, expect, it } from "@jest/globals";
import { TestTaskEventType, TestTaskEventsBus } from "./task-events-bus.js";

describe("TestTaskEventsBus", () => {
  it("stores emitted started events and exposes them by task id", () => {
    const bus = new TestTaskEventsBus();

    bus.emitStarted(10, { foo: "bar" });

    const events = bus.events(10).toArray;

    expect(events).toEqual([
      {
        type: TestTaskEventType.started,
        taskId: 10,
        payload: { foo: "bar" },
      },
    ]);
  });

  it("resolves waiter immediately when the event was already emitted", async () => {
    const bus = new TestTaskEventsBus();
    bus.emitCompleted(10, { ok: true });

    await expect(bus.waitForCompleted(10)).resolves.toEqual({
      type: TestTaskEventType.completed,
      taskId: 10,
      result: { ok: true },
    });
  });

  it("resolves waiter after a future event emission", async () => {
    const bus = new TestTaskEventsBus();
    const started = bus.waitForStarted(10);

    bus.emitStarted(10, { foo: "bar" });

    await expect(started).resolves.toEqual({
      type: TestTaskEventType.started,
      taskId: 10,
      payload: { foo: "bar" },
    });
  });
});
