import { describe, expect, it } from "@jest/globals";
import { ManagedWorkflowTask } from "../src/managed-workflow-task.js";

class TestManagedWorker extends ManagedWorkflowTask<{ id: string }> {
  constructor(maxRuns?: number) {
    super(maxRuns);
  }

  protected override async run(): Promise<void> {
    return;
  }

  exposeGetMaxRuns(): number {
    return this.maxRuns;
  }
}

describe("ManagedWorkflowTask maxRuns", () => {
  it("uses default maxRuns=100 when constructor arg is omitted", () => {
    const worker = new TestManagedWorker();
    expect(worker.exposeGetMaxRuns()).toBe(100);
  });

  it("accepts maxRuns from constructor", () => {
    const worker = new TestManagedWorker(7);
    expect(worker.exposeGetMaxRuns()).toBe(7);
  });

  it("rejects non-positive or non-finite maxRuns from constructor", () => {
    expect(() => new TestManagedWorker(0)).toThrow(
      "Managed workflow maxRuns must be a positive integer",
    );
    expect(() => new TestManagedWorker(-1)).toThrow(
      "Managed workflow maxRuns must be a positive integer",
    );
    expect(() => new TestManagedWorker(Number.POSITIVE_INFINITY)).toThrow(
      "Managed workflow maxRuns must be a positive integer",
    );
    expect(() => new TestManagedWorker(Number.NaN)).toThrow(
      "Managed workflow maxRuns must be a positive integer",
    );
    expect(() => new TestManagedWorker(12.9)).toThrow(
      "Managed workflow maxRuns must be a positive integer",
    );
  });

  it("keeps integer maxRuns unchanged", () => {
    const worker = new TestManagedWorker(12);
    expect(worker.exposeGetMaxRuns()).toBe(12);
  });
});
