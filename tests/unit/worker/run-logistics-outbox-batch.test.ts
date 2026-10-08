import { describe, expect, it } from "vitest";

import type { ProcessOutboxEventsResult } from "../../../src/worker/outbox/process-outbox-events";
import { runLogisticsOutboxBatch } from "../../../src/worker/outbox/run-logistics-outbox-batch";

describe("run logistics outbox batch", () => {
  it("processes one configured logistics outbox batch", async () => {
    const calls: Array<{ batchSize: number; now?: Date }> = [];
    const result: ProcessOutboxEventsResult = { processed: 2, retried: 1, failed: 0 };
    const now = new Date("2026-09-25T21:00:00.000Z");

    await expect(
      runLogisticsOutboxBatch({
        processor: {
          processBatch: async (options) => {
            calls.push(options);
            return result;
          }
        },
        config: { batchSize: 25 },
        now
      })
    ).resolves.toBe(result);

    expect(calls).toEqual([{ batchSize: 25, now }]);
  });

  it("propagates processor failures without retrying locally", async () => {
    const calls: Array<{ batchSize: number; now?: Date }> = [];
    const failure = new Error("falha transitoria da outbox");

    await expect(
      runLogisticsOutboxBatch({
        processor: {
          processBatch: async (options) => {
            calls.push(options);
            throw failure;
          }
        },
        config: { batchSize: 10 }
      })
    ).rejects.toBe(failure);

    expect(calls).toEqual([{ batchSize: 10, now: undefined }]);
  });
});
