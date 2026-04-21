import "reflect-metadata";

/**
 * Metadata key that marks methods as queue workers.
 */
export const TASKS_QUEUE_WORKER_METADATA = Symbol(
  "tasks-queue-worker-metadata",
);

/**
 * Method-level registration options for queue workers discovered via NestJS.
 */
export interface WorkerOptions {
  /**
   * Queue name this method should consume.
   */
  queue: string;
  /**
   * Optional pool name. If omitted, defaults to `default`.
   */
  pool?: string;
}

/**
 * Mark a provider method as a queue worker handler.
 *
 * The method should follow the runtime contract:
 * `(payload: any, context: TaskContext) => Promise<void>`.
 */
export const Worker = (options: WorkerOptions): MethodDecorator => {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    if (typeof descriptor.value !== "function") {
      throw new Error("@Worker decorator can only be applied to methods");
    }

    Reflect.defineMetadata(
      TASKS_QUEUE_WORKER_METADATA,
      { ...options },
      descriptor.value,
    );
  };
};
