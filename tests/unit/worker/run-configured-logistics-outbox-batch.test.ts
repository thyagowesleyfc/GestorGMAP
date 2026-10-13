import { describe, expect, it, vi } from "vitest";

import type { ConfiguredLogisticsOutboxWorker } from "../../../src/worker/outbox/create-configured-logistics-outbox-worker";
import type {
  ProcessOutboxEventsOptions,
  ProcessOutboxEventsResult
} from "../../../src/worker/outbox/process-outbox-events";
import { runConfiguredLogisticsOutboxBatch } from "../../../src/worker/outbox/run-configured-logistics-outbox-batch";

type BatchCall = { batchSize: number; now?: Date };

describe("run configured logistics outbox batch", () => {
  it("runs one configured batch and closes resources", async () => {
    const calls: BatchCall[] = [];
    const close = vi.fn(async () => undefined);
    const now = new Date("2026-09-25T21:30:00.000Z");
    const result = { processed: 1, retried: 0, failed: 0 };
    const worker = makeWorker({
      batchSize: 12,
      close,
      processBatch: async (options) => {
        calls.push(options);
        return result;
      }
    });
    const workerFactory = vi.fn(() => worker);

    await expect(
      runConfiguredLogisticsOutboxBatch({
        now,
        workerFactory
      })
    ).resolves.toBe(result);

    expect(workerFactory).toHaveBeenCalledWith({});
    expect(calls).toEqual([{ batchSize: 12, now }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes resources and propagates processor failures", async () => {
    const close = vi.fn(async () => undefined);
    const failure = new Error("provedor de e-mail indisponivel");
    const worker = makeWorker({
      batchSize: 10,
      close,
      processBatch: async () => {
        throw failure;
      }
    });

    await expect(
      runConfiguredLogisticsOutboxBatch({
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
