import { describe, expect, it, vi } from "vitest";

import type { ConfiguredLogisticsOutboxWorker } from "../../../src/worker/outbox/create-configured-logistics-outbox-worker";
import type {
  ProcessOutboxEventsOptions,
  ProcessOutboxEventsResult
} from "../../../src/worker/outbox/process-outbox-events";
import { runConfiguredLogisticsOutboxLoop } from "../../../src/worker/outbox/run-configured-logistics-outbox-loop";

type BatchCall = { batchSize: number; now?: Date };

describe("run configured logistics outbox loop", () => {
  it("runs the configured loop and closes resources on abort", async () => {
    const controller = new AbortController();
    const calls: BatchCall[] = [];
    const close = vi.fn(async () => undefined);
    const worker = makeWorker({
      batchSize: 8,
      close,
      processBatch: async (options) => {
        calls.push(options);
        return { processed: 1, retried: 0, failed: 0 };
      }
    });
    const workerFactory = vi.fn(() => worker);

    const summary = await runConfiguredLogisticsOutboxLoop({
      signal: controller.signal,
      workerFactory,
      activeDelayMs: 1,
      sleep: async () => controller.abort()
    });

    expect(workerFactory).toHaveBeenCalledWith({});
    expect(summary).toEqual({ iterations: 1, processed: 1, retried: 0, failed: 0 });
    expect(calls).toEqual([{ batchSize: 8, now: undefined }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes resources and propagates processor failures", async () => {
    const close = vi.fn(async () => undefined);
    const failure = new Error("banco indisponivel");
    const worker = makeWorker({
      batchSize: 10,
      close,
      processBatch: async () => {
        throw failure;
      }
    });

    await expect(
      runConfiguredLogisticsOutboxLoop({
        workerFactory: () => worker
      })
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function makeWorker(input: {
  batchSize: number;
  close: () => Promise<void>;
  processBatch: (options: BatchCall) => Promise<ProcessOutboxEventsResult>;
}): ConfiguredLogisticsOutboxWorker {
  return {
    handler: {
      handle: async () => undefined
    },
    processor: {
      processBatch: async (options?: ProcessOutboxEventsOptions) =>
        input.processBatch(options as BatchCall)
    },
    config: {
      databaseUrl: "postgresql://gestor_gmap:secret@127.0.0.1:55432/gestor_gmap",
      deliveryEmailRecipients: ["gmap-logistica@example.test"],
      managementTargetTeamContext: "GERENCIA_MATERIAIS",
      batchSize: input.batchSize,
      smtpEmail: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "GMAP <gmap@example.test>"
      }
    },
    pool: {
      end: async () => undefined
    },
    close: input.close
  } as unknown as ConfiguredLogisticsOutboxWorker;
}
