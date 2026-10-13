import { pathToFileURL } from "node:url";

import {
  runConfiguredLogisticsOutboxBatch,
  type RunConfiguredLogisticsOutboxBatchInput
} from "../src/worker/outbox/run-configured-logistics-outbox-batch";

export type ConsoleOutput = {
  log(message: string): void;
  error(message: unknown): void;
};

export type RunLogisticsOutboxBatchCliInput = {
  output?: ConsoleOutput;
  runBatch?: (
    input?: RunConfiguredLogisticsOutboxBatchInput
  ) => ReturnType<typeof runConfiguredLogisticsOutboxBatch>;
};

export async function runLogisticsOutboxBatchCli(
  input: RunLogisticsOutboxBatchCliInput = {}
): Promise<number> {
  const output = input.output ?? console;
  const runBatch = input.runBatch ?? runConfiguredLogisticsOutboxBatch;

  try {
    const result = await runBatch();

    output.log(
      [
        "Worker de Logistica processou um lote da Outbox.",
        `processados=${result.processed}`,
        `retentativas=${result.retried}`,
        `falhas=${result.failed}`
      ].join(" ")
    );

    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLogisticsOutboxBatchCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
