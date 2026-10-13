import { pathToFileURL } from "node:url";

import {
  runConfiguredLogisticsOutboxLoop,
  type RunConfiguredLogisticsOutboxLoopInput
} from "../src/worker/outbox/run-configured-logistics-outbox-loop";

export type ConsoleOutput = {
  log(message: string): void;
  error(message: unknown): void;
};

export type ProcessSignals = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
};

export type RunLogisticsOutboxLoopCliInput = {
  output?: ConsoleOutput;
  processSignals?: ProcessSignals;
  runLoop?: (
    input?: RunConfiguredLogisticsOutboxLoopInput
  ) => ReturnType<typeof runConfiguredLogisticsOutboxLoop>;
};

export async function runLogisticsOutboxLoopCli(
  input: RunLogisticsOutboxLoopCliInput = {}
): Promise<number> {
  const output = input.output ?? console;
  const processSignals = input.processSignals ?? process;
  const runLoop = input.runLoop ?? runConfiguredLogisticsOutboxLoop;
  const controller = new AbortController();

  processSignals.once("SIGINT", () => controller.abort());
  processSignals.once("SIGTERM", () => controller.abort());

  try {
    output.log("Worker de Logistica iniciado para processar a Outbox.");
    const result = await runLoop({ signal: controller.signal });

    output.log(
      [
        "Worker de Logistica encerrado.",
        `iteracoes=${result.iterations}`,
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
  runLogisticsOutboxLoopCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
