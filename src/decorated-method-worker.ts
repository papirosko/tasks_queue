import { TaskContext } from "./tasks-model.js";
import { TasksWorker } from "./tasks-worker.js";

/**
 * Internal adapter that turns a provider method into a {@link TasksWorker}.
 */
export class DecoratedMethodWorker extends TasksWorker {
  constructor(
    private readonly instance: Record<string, unknown>,
    private readonly methodName: string,
  ) {
    super();
  }

  override async process(payload: any, context: TaskContext): Promise<void> {
    const method = this.instance[this.methodName];
    if (typeof method !== "function") {
      throw new Error(
        `Decorated handler method '${this.methodName}' is not a function`,
      );
    }
    await method.call(this.instance, payload, context);
  }
}
