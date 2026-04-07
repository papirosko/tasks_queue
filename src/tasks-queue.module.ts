import {
  DynamicModule,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Provider,
} from "@nestjs/common";
import { TasksQueueDao } from "./tasks-queue.dao.js";
import { TasksPoolsService } from "./tasks-pools.service.js";
import {
  TASKS_QUEUE_OPTIONS,
  TasksQueueAsyncOptions,
  TasksQueueModuleOptions,
  TasksQueueOptionsFactory,
} from "./tasks-queue-async-options.js";
import { Type } from "@nestjs/common/interfaces";
import { ModuleRef } from "@nestjs/core";
import { TimeUtils } from "./time-utils.js";
import { ManageTasksQueueService } from "./manage-tasks-queue.service.js";
import { identity, option } from "scats";

@Module({})
/**
 * NestJS integration module for the task queue library.
 *
 * The module wires together {@link TasksPoolsService},
 * {@link ManageTasksQueueService}, and internal persistence services, then
 * starts and stops queue processing with the NestJS application lifecycle.
 *
 * Use {@link forRootAsync} to configure database access and worker pools.
 */
export class TasksQueueModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Create a dynamically configured queue module.
   *
   * The resulting module exports {@link TasksPoolsService} for scheduling and
   * worker registration, and {@link ManageTasksQueueService} for operational
   * management queries and mutations.
   *
   * @param options async configuration strategy
   * @returns configured NestJS dynamic module
   */
  static forRootAsync(options: TasksQueueAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    return {
      module: TasksQueueModule,
      imports: options.imports,
      providers: [
        ...asyncProviders,
        {
          provide: TasksQueueDao,
          inject: [TASKS_QUEUE_OPTIONS],
          useFactory: (opts: TasksQueueModuleOptions) =>
            new TasksQueueDao(opts.db),
        },
        {
          provide: ManageTasksQueueService,
          inject: [TASKS_QUEUE_OPTIONS],
          useFactory: (opts: TasksQueueModuleOptions) =>
            new ManageTasksQueueService(opts.db),
        },
        {
          provide: TasksPoolsService,
          inject: [TasksQueueDao, ManageTasksQueueService, TASKS_QUEUE_OPTIONS],
          useFactory: (
            dao: TasksQueueDao,
            manageService: ManageTasksQueueService,
            opts: TasksQueueModuleOptions,
          ) =>
            new TasksPoolsService(
              dao,
              manageService,
              option(opts.runAuxiliaryWorker).forall(identity),
              opts.pools,
            ),
        },
      ],
      exports: [TasksPoolsService, ManageTasksQueueService],
    };
  }

  private static createAsyncProviders(
    options: TasksQueueAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<TasksQueueOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: TasksQueueAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: TASKS_QUEUE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }
    // `as Type<TasksQueueOptionsFactory>` is a workaround for microsoft/TypeScript#31603
    return {
      provide: TASKS_QUEUE_OPTIONS,
      useFactory: async (optionsFactory: TasksQueueOptionsFactory) =>
        await optionsFactory.createTelegrafOptions(),
      inject: [
        (options.useClass ||
          options.useExisting) as Type<TasksQueueOptionsFactory>,
      ],
    };
  }

  /**
   * Start queue processing after NestJS application bootstrap.
   *
   * @returns nothing; workers and optional auxiliary processing start in the background
   */
  onApplicationBootstrap(): void {
    const poolsService =
      this.moduleRef.get<TasksPoolsService>(TasksPoolsService);
    poolsService.start();
  }

  /**
   * Stop queue processing during NestJS application shutdown.
   *
   * @returns resolved promise once queue services stop gracefully
   */
  async onApplicationShutdown(): Promise<void> {
    const poolsService =
      this.moduleRef.get<TasksPoolsService>(TasksPoolsService);
    await poolsService.stop(TimeUtils.minute);
  }
}
