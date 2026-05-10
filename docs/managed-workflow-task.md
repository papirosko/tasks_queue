# ManagedWorkflowTask

`ManagedWorkflowTask` is an orchestration base class built on top of
`MultiStepTask` for full parent-side control over spawned tasks.

Use it when:

- you need full control over child-task creation from parent code
- workflow may spawn an unbounded number of child tasks over time
- child tasks must be spawned in arbitrary order based on runtime decisions

## Goal

`ManagedWorkflowTask` enforces a run-level contract while keeping workflow
shape fully dynamic.

- either call `context.spawnChild(...)`
- or call `context.submitResult(...)`

Calling both in the same run is treated as an orchestration error. Calling
neither is also treated as an orchestration error.

## How it is implemented

The base class:

1. reads and validates persisted `workflowPayload.runCount`
2. checks `maxRuns` guard for the next run
3. calls subclass `run(userPayload, context)`
4. validates that exactly one orchestration action happened in this run
5. persists updated `runCount` together with normal transition:
   - child spawn, or
   - result submit

`context.setPayload(...)` inside `run(...)` is wrapped to update only
`userPayload`, while technical metadata (`runCount`) remains in
`workflowPayload`.

`runCount` persistence is **success-path only**:

- when parent pass reaches normal orchestration transition (`spawnChild` or `submitResult`), updated `runCount` is persisted
- when parent pass throws before successful transition, queue fail path persists the original payload for that attempt

## Important nuances

- The class does not change queue-core persistence semantics:
  - child scheduling still happens only after successful parent return
  - parent wake-up still depends on child terminal state
- If `submitResult(...)` was called and the run then fails terminally,
  submitted result may still be persisted (same core behavior as regular tasks).
- Default `childFailed(...)` behavior from `MultiStepTask` still applies unless
  overridden (for example to implement `allowFailure` continuation policy).
- `maxRuns` protects against infinite orchestration loops.
- `maxRuns` is configured only through constructor argument (`super(20)`) and
  is immutable afterwards. Value must be a positive integer.

## Example: AI planning + per-file generation

```ts
type GenerateFilesPayload = {
  prompt: string;
  plannedFiles?: string[];
  nextFileIndex?: number;
  generatedFiles?: Array<{ path: string; content: string }>;
};

class GenerateFilesManagedWorker extends ManagedWorkflowTask<GenerateFilesPayload> {
  constructor() {
    super(20);
  }

  protected override async run(
    userPayload: GenerateFilesPayload,
    context: TaskContext,
  ): Promise<void> {
    const plannedInPayload = option(userPayload.plannedFiles).getOrElseValue([]);
    const resolved = context.resolvedChildTask.flatMap((task) => task.result);

    // First run: ask AI to produce file plan.
    if (plannedInPayload.length === 0 && resolved.isEmpty) {
      context.spawnChild({
        queue: "ai-plan-files",
        payload: { prompt: userPayload.prompt },
      });
      return;
    }

    // Resume after planner child: store plan and start first file generation.
    if (plannedInPayload.length === 0 && resolved.isDefined) {
      const plannedFiles = resolved
        .map((r) => (Array.isArray(r["files"]) ? (r["files"] as string[]) : []))
        .getOrElseValue([]);

      if (plannedFiles.length === 0) {
        context.submitResult({
          files: [],
        });
        return;
      }

      context.setPayload({
        ...userPayload,
        plannedFiles,
        nextFileIndex: 1,
        generatedFiles: [],
      });

      context.spawnChild({
        queue: "ai-generate-file",
        payload: { path: plannedFiles[0] },
      });
      return;
    }

    const plannedFiles = option(userPayload.plannedFiles).getOrElseValue([]);
    const currentIndex = option(userPayload.nextFileIndex).getOrElseValue(0);
    const generatedSoFar = option(userPayload.generatedFiles).getOrElseValue([]);

    const generatedWithLastChild = resolved
      .map((r) => [
        ...generatedSoFar,
        {
          path: String(option(r["path"]).getOrElseValue("")),
          content: String(option(r["content"]).getOrElseValue("")),
        },
      ])
      .getOrElseValue(generatedSoFar);

    // Final pass: all files are generated.
    if (generatedWithLastChild.length >= plannedFiles.length) {
      context.setPayload({
        ...userPayload,
        generatedFiles: generatedWithLastChild,
        nextFileIndex: currentIndex,
      });
      context.submitResult({
        files: generatedWithLastChild,
      });
      return;
    }

    // Continue sequential generation.
    context.setPayload({
      ...userPayload,
      generatedFiles: generatedWithLastChild,
      nextFileIndex: currentIndex + 1,
    });
    context.spawnChild({
      queue: "ai-generate-file",
      payload: { path: plannedFiles[currentIndex] },
    });
  }
}
```
