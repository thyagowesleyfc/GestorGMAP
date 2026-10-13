import { describe, expect, it } from "vitest";

import { runLogisticsOutboxBatchCli } from "../../../scripts/run-logistics-outbox-batch";

describe("run logistics outbox batch script", () => {
  it("prints the batch result and exits successfully", async () => {
    const logs: string[] = [];
    const errors: unknown[] = [];

    await expect(
      runLogisticsOutboxBatchCli({
        output: {
          log: (message) => logs.push(message),
          error: (message) => errors.push(message)
        },
        runBatch: async () => ({ processed: 2, retried: 1, failed: 0 })
      })
    ).resolves.toBe(0);

    expect(logs).toEqual([
      "Worker de Logistica processou um lote da Outbox. processados=2 retentativas=1 falhas=0"
    ]);
    expect(errors).toEqual([]);
  });

  it("prints processor errors and exits with failure", async () => {
    const logs: string[] = [];
    const errors: unknown[] = [];

    await expect(
      runLogisticsOutboxBatchCli({
        output: {
          log: (message) => logs.push(message),
          error: (message) => errors.push(message)
        },
        runBatch: async () => {
          throw new Error("DATABASE_URL deve ser informado.");
        }
      })
    ).resolves.toBe(1);

    expect(logs).toEqual([]);
    expect(errors).toEqual(["DATABASE_URL deve ser informado."]);
  });
});
