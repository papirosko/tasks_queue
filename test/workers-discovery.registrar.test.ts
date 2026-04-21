import { jest } from "@jest/globals";
import { MetadataScanner } from "@nestjs/core";
import { TaskContext } from "../src/tasks-model.js";
import { TasksWorker } from "../src/tasks-worker.js";
import { Worker } from "../src/worker.decorator.js";
import { WorkersDiscoveryRegistrar } from "../src/workers-discovery.registrar.js";

class FinanceWorkers {
  lastPayoutPayload: any = null;
  lastDocumentPayload: any = null;

  @Worker({ queue: "finance-payout" })
  async processPayout(payload: any, _ctx: TaskContext): Promise<void> {
    this.lastPayoutPayload = payload;
  }

  @Worker({ queue: "finance-documents", pool: "documents" })
  async downloadDocument(payload: any, _ctx: TaskContext): Promise<void> {
    this.lastDocumentPayload = payload;
  }

  async nonWorkerMethod(_payload: any): Promise<void> {
    return Promise.resolve();
  }
}

describe("WorkersDiscoveryRegistrar", () => {
  it("discovers @Worker methods and registers adapters in task pools", async () => {
    const workers = new FinanceWorkers();
    const discoveryService = {
      getProviders: jest.fn(() => [{ instance: workers }]),
    } as any;
    const metadataScanner = new MetadataScanner();
    const tasksPoolsService = {
      registerWorker: jest.fn(),
    } as any;

    const registrar = new WorkersDiscoveryRegistrar(
      discoveryService,
      metadataScanner,
      tasksPoolsService,
    );

    registrar.onModuleInit();

    expect(tasksPoolsService.registerWorker).toHaveBeenCalledTimes(2);

    const firstCall = tasksPoolsService.registerWorker.mock.calls[0];
    expect(firstCall[0]).toBe("finance-payout");
    expect(firstCall).toHaveLength(2);
    expect(firstCall[1]).toBeInstanceOf(TasksWorker);

    const secondCall = tasksPoolsService.registerWorker.mock.calls[1];
    expect(secondCall[0]).toBe("finance-documents");
    expect(secondCall[2]).toBe("documents");
    expect(secondCall[1]).toBeInstanceOf(TasksWorker);

    const payoutAdapter = firstCall[1] as TasksWorker;
    await payoutAdapter.process({ id: 10 }, {} as TaskContext);
    expect(workers.lastPayoutPayload).toEqual({ id: 10 });

    const documentsAdapter = secondCall[1] as TasksWorker;
    await documentsAdapter.process({ docId: "d-1" }, {} as TaskContext);
    expect(workers.lastDocumentPayload).toEqual({ docId: "d-1" });
  });
});
