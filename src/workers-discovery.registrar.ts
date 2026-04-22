import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { TasksPoolsService } from "./tasks-pools.service.js";
import {
  TASKS_QUEUE_WORKER_METADATA,
  WorkerOptions,
} from "./worker.decorator.js";
import { DecoratedMethodWorker } from "./decorated-method-worker.js";

/**
 * Discovers provider methods marked with {@link Worker} and registers them in queue pools.
 */
@Injectable()
export class WorkersDiscoveryRegistrar implements OnModuleInit {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly tasksPoolsService: TasksPoolsService,
  ) {}

  onModuleInit(): void {
    this.discoveryService.getProviders().forEach((wrapper) => {
      const instance = wrapper.instance as
        | Record<string, unknown>
        | undefined
        | null;
      if (
        instance === undefined ||
        instance === null ||
        typeof instance !== "object"
      ) {
        return;
      }
      const prototype = Object.getPrototypeOf(instance);
      if (prototype === undefined || prototype === null) {
        return;
      }

      this.metadataScanner.scanFromPrototype(
        instance,
        prototype,
        (methodName: string) => {
          const method = prototype[methodName];
          if (typeof method !== "function") {
            return;
          }
          const options = Reflect.getMetadata(
            TASKS_QUEUE_WORKER_METADATA,
            method,
          ) as WorkerOptions | undefined;
          if (options === undefined) {
            return;
          }

          const decoratedWorker = new DecoratedMethodWorker(
            instance,
            methodName,
          );
          if (options.pool === undefined) {
            this.tasksPoolsService.registerWorker(
              options.queue,
              decoratedWorker,
            );
          } else {
            this.tasksPoolsService.registerWorker(
              options.queue,
              decoratedWorker,
              options.pool,
            );
          }
        },
      );
    });
  }
}
