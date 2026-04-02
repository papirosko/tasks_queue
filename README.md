# 🧵 @penkov/tasks_queue

**@penkov/tasks_queue** is a lightweight, PostgreSQL-backed task queue system designed for:

- delayed execution (`start_after`)
- retries with exponential or linear `backoff`
- maximum attempt limits (`max_attempts`)
- task prioritization (`priority`)
- recurring tasks (`repeat_type`)
- observability (metrics, stalled task handling)

It’s built for efficiency and flexibility in modern `Node.js` applications, and works seamlessly with `NestJS`.

---

## 🚀 Installation

```bash
npm install @penkov/tasks_queue
```

Install peer dependencies if not already present:

```bash
npm install pg tslib application-metrics log4js scats
```

> For NestJS integration:

```bash
npm install @nestjs/common @nestjs/core
```

---

## 🤩 Usage with NestJS
Apply [migration.sql](migration.sql) on your db, or add a new migration file to your migrations.

For long-running workers that need periodic liveness updates, see [docs/heartbeat.md](docs/heartbeat.md).

Additional documentation:

- [docs/heartbeat.md](docs/heartbeat.md) - how task heartbeats work and when to call `TaskContext.ping()` in long-running workers.
- [docs/multi-steps-tasks.md](docs/multi-steps-tasks.md) - how to build parent-child workflows with `MultiStepTask`, `SequentialTask`, `MultiStepPayload`, and optional child `allowFailure` orchestration.


Register the queue module in your app. You have to provide pg.Pool

```ts
import { Module } from '@nestjs/common';
import { TasksQueueModule } from 'tasks_queue';

@Module({
  imports: [
      TasksQueueModule.forRootAsync({
          inject: [pg.Pool],
          useFactory: (db: pg.Pool) => ({
              db: db,
              pools: [
                  {
                      name: DEFAULT_POOL,
                      loopInterval: TimeUtils.minute,
                      concurrency: 2
                  },
                  {
                      name: 'preview',
                      loopInterval: TimeUtils.minute,
                      concurrency: 5
                  },
              ]
          })
      }),
  ],
})
export class AppModule {}
```

Create a worker and register a task handler:

```ts
@Injectable()
export class GeneratePreviewTaskWorker extends TasksWorker implements OnApplicationBootstrap {
    static readonly QUEUE_NAME = 'generate-preview';

    constructor(
        @Inject(STORAGE_CONFIG) private readonly storageConf: StorageConfig,
        private readonly offeredServiceImagesDao: OfferedServiceImagesDao,
        private readonly tasksQueueService: TasksPoolsService
    ) {
        super();
    }

    async onApplicationBootstrap() {
        this.tasksQueueService.registerWorker(GeneratePreviewTaskWorker.QUEUE_NAME, this, 'preview');
    }

    async process(payload: any, context: TaskContext): Promise<void> {
        const imageId = payload['imageId'] as number;
        await context.ping();
        // ...
    }
}
```

Long-running workers can use `TaskContext.ping()` to refresh task heartbeat and avoid false stalled detection while work is still progressing.

Submit tasks:
```typescript
private readonly tasks: TasksPoolsService,
//...
await this.tasks.schedule({
    queue: GeneratePreviewTaskWorker.QUEUE_NAME,
    payload: { imageId: imageId }
});

```
