import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { mutable } from "scats";
import { TasksPoolsService } from "./tasks-pools.service.js";
import {
  ScheduledTaskOptions,
  TASKS_QUEUE_SCHEDULED_TASK_METADATA,
} from "./scheduled-task.decorator.js";
import {
  ScheduleCronTaskDetails,
  SchedulePeriodicTaskDetails,
} from "./tasks-model.js";
import {
  TASKS_QUEUE_WORKER_METADATA,
  WorkerOptions,
} from "./worker.decorator.js";

/**
 * Discovers provider methods marked with {@link ScheduledTask} and persists
 * periodic task definitions.
 */
@Injectable()
export class ScheduledTasksRegistrar implements OnModuleInit {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly tasksPoolsService: TasksPoolsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const schedulePromises = new mutable.ArrayBuffer<Promise<void>>();

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
          this.assertWorkerQueueMatchIfDecorated(method, options, methodName);

          schedulePromises.append(this.schedule(options));
        },
      );
    });

    await Promise.all(schedulePromises.toArray);
  }

  private assertWorkerQueueMatchIfDecorated(
    method: (...args: unknown[]) => unknown,
    options: ScheduledTaskOptions,
    methodName: string,
  ): void {
    const workerOptions = Reflect.getMetadata(
      TASKS_QUEUE_WORKER_METADATA,
      method,
    ) as WorkerOptions | undefined;
    if (workerOptions !== undefined && workerOptions.queue !== options.queue) {
      throw new Error(
        `@ScheduledTask queue '${options.queue}' does not match @Worker queue '${workerOptions.queue}' on method '${methodName}'`,
      );
    }
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
