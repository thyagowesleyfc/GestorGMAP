import { describe, expect, it } from "vitest";

import { runLogisticsOutboxLoop } from "../../../src/worker/outbox/run-logistics-outbox-loop";
import type { ProcessOutboxEventsResult } from "../../../src/worker/outbox/process-outbox-events";

describe("run logistics outbox loop", () => {
  it("keeps processing batches until the signal is aborted", async () => {
    const controller = new AbortController();
    const calls: Array<{ batchSize: number; now?: Date }> = [];
    const results: ProcessOutboxEventsResult[] = [
      { processed: 2, retried: 0, failed: 0 },
      { processed: 0, retried: 1, failed: 0 }
    ];
    const now = new Date("2026-09-25T22:00:00.000Z");

    const summary = await runLogisticsOutboxLoop({
      processor: {
        processBatch: async (options) => {
          calls.push(options);
          return results.shift() ?? { processed: 0, retried: 0, failed: 0 };
        }
      },
      config: { batchSize: 20 },
      signal: controller.signal,
      now: () => now,
      onBatchResult: () => {
        if (calls.length === 2) {
          controller.abort();
        }
      }
    });

    expect(summary).toEqual({ iterations: 2, processed: 2, retried: 1, failed: 0 });
    expect(calls).toEqual([
      { batchSize: 20, now },
      { batchSize: 20, now }
    ]);
  });

  it("waits with the idle delay when a batch does no work", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];

    const summary = await runLogisticsOutboxLoop({
      processor: {
        processBatch: async () => ({ processed: 0, retried: 0, failed: 0 })
      },
      config: { batchSize: 10 },
      signal: controller.signal,
      idleDelayMs: 250,
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
        controller.abort();
      }
    });

    expect(summary).toEqual({ iterations: 1, processed: 0, retried: 0, failed: 0 });
    expect(sleeps).toEqual([250]);
  });

  it("propagates processor failures without retrying locally", async () => {
    let attempts = 0;
    const failure = new Error("banco indisponivel");

    await expect(
      runLogisticsOutboxLoop({
        processor: {
          processBatch: async () => {
            attempts += 1;
            throw failure;
          }
        },
        config: { batchSize: 10 }
      })
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("rejects invalid delay configuration", async () => {
    await expect(
      runLogisticsOutboxLoop({
        processor: {
          processBatch: async () => ({ processed: 0, retried: 0, failed: 0 })
        },
        config: { batchSize: 10 },
        idleDelayMs: -1
      })
    ).rejects.toThrow(/idleDelayMs/);
  });
});
