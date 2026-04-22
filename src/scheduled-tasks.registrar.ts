import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleInit,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { mutable, option } from "scats";
import { DEFAULT_POOL, TasksPoolsService } from "./tasks-pools.service.js";
import {
  ScheduledTaskOptions,
  TASKS_QUEUE_SCHEDULED_TASK_METADATA,
} from "./scheduled-task.decorator.js";
import {
  ScheduleCronTaskDetails,
  SchedulePeriodicTaskDetails,
} from "./tasks-model.js";
import { TASKS_QUEUE_WORKER_METADATA } from "./worker.decorator.js";
import { DecoratedMethodWorker } from "./decorated-method-worker.js";

interface ScheduledMethodDefinition {
  options: ScheduledTaskOptions;
}

/**
 * Discovers provider methods marked with {@link ScheduledTask} and persists
 * periodic task definitions.
 */
@Injectable()
export class ScheduledTasksRegistrar
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly scheduledMethods =
    new mutable.ArrayBuffer<ScheduledMethodDefinition>();

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
            TASKS_QUEUE_SCHEDULED_TASK_METADATA,
            method,
          ) as ScheduledTaskOptions | undefined;
          if (options === undefined) {
            return;
          }
          this.assertWorkerDecoratorNotPresent(methodName, method);
          this.registerWorker(instance, methodName, options);
          this.scheduledMethods.append({
            options,
          });
        },
      );
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const schedulePromises = this.scheduledMethods.map((definition) =>
      this.schedule(definition.options),
    ).toArray;
    await Promise.all(schedulePromises);
  }

  private assertWorkerDecoratorNotPresent(
    methodName: string,
    method: (...args: unknown[]) => unknown,
  ): void {
    const workerOptions = Reflect.getMetadata(
      TASKS_QUEUE_WORKER_METADATA,
      method,
    ) as unknown;
    if (workerOptions !== undefined) {
      throw new Error(
        `@ScheduledTask cannot be combined with @Worker on method '${methodName}'`,
      );
    }
  }

  private registerWorker(
    instance: Record<string, unknown>,
    methodName: string,
    options: ScheduledTaskOptions,
  ): void {
    const decoratedWorker = new DecoratedMethodWorker(instance, methodName);
    this.tasksPoolsService.registerWorker(
      options.queue,
      decoratedWorker,
      option(options.pool).getOrElseValue(DEFAULT_POOL),
    );
  }

  private async schedule(options: ScheduledTaskOptions): Promise<void> {
    if (options.cron !== undefined) {
      const task: ScheduleCronTaskDetails = {
        name: options.name,
        queue: options.queue,
        cronExpression: options.cron,
        startAfter: options.startAfter,
        priority: options.priority,
        payload: options.payload,
        timeout: options.timeout,
        retries: options.retries,
        backoff: options.backoff,
        backoffType: options.backoffType,
        missedRunStrategy: options.missedRunStrategy,
        replaceExisting: options.replaceExisting,
      };
      await this.tasksPoolsService.scheduleAtCron(task);
      return;
    }

    if (options.fixedRate !== undefined) {
      const task: SchedulePeriodicTaskDetails = {
        name: options.name,
        queue: options.queue,
        period: options.fixedRate,
        startAfter: options.startAfter,
        priority: options.priority,
        payload: options.payload,
        timeout: options.timeout,
        retries: options.retries,
        backoff: options.backoff,
        backoffType: options.backoffType,
        missedRunStrategy: options.missedRunStrategy,
        replaceExisting: options.replaceExisting,
      };
      await this.tasksPoolsService.scheduleAtFixedRate(task);
      return;
    }

    if (options.fixedDelay === undefined) {
      throw new Error(
        "@ScheduledTask requires one of: cron, fixedRate, fixedDelay",
      );
    }
    const task: SchedulePeriodicTaskDetails = {
      name: options.name,
      queue: options.queue,
      period: options.fixedDelay,
      startAfter: options.startAfter,
      priority: options.priority,
      payload: options.payload,
      timeout: options.timeout,
      retries: options.retries,
      backoff: options.backoff,
      backoffType: options.backoffType,
      missedRunStrategy: options.missedRunStrategy,
      replaceExisting: options.replaceExisting,
    };
    await this.tasksPoolsService.scheduleAtFixedDelay(task);
  }
}
