import { describe, expect, it, vi } from "vitest";

import { runLogisticsOutboxLoopCli } from "../../../scripts/run-logistics-outbox-loop";

describe("run logistics outbox loop script", () => {
  it("registers shutdown signals and prints the loop result", async () => {
    const logs: string[] = [];
    const errors: unknown[] = [];
    const signals: string[] = [];

    await expect(
      runLogisticsOutboxLoopCli({
        output: {
          log: (message) => logs.push(message),
          error: (message) => errors.push(message)
        },
        processSignals: {
          once: (event) => {
            signals.push(event);
          }
        },
        runLoop: async () => ({ iterations: 2, processed: 3, retried: 1, failed: 0 })
      })
    ).resolves.toBe(0);

    expect(signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(logs).toEqual([
      "Worker de Logistica iniciado para processar a Outbox.",
      "Worker de Logistica encerrado. iteracoes=2 processados=3 retentativas=1 falhas=0"
    ]);
    expect(errors).toEqual([]);
  });

  it("prints loop errors and exits with failure", async () => {
    const errors: unknown[] = [];

    await expect(
      runLogisticsOutboxLoopCli({
        output: {
          log: () => undefined,
          error: (message) => errors.push(message)
        },
        processSignals: {
          once: vi.fn()
        },
        runLoop: async () => {
          throw new Error("DATABASE_URL deve ser informado.");
        }
      })
    ).resolves.toBe(1);

    expect(errors).toEqual(["DATABASE_URL deve ser informado."]);
  });
});
