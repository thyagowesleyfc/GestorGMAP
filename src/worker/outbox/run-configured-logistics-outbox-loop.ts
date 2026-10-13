import {
  createConfiguredLogisticsOutboxWorker,
  type ConfiguredLogisticsOutboxWorker,
  type CreateConfiguredLogisticsOutboxWorkerInput
} from "./create-configured-logistics-outbox-worker";
import {
  runLogisticsOutboxLoop,
  type LogisticsOutboxLoopSleeper,
  type LogisticsOutboxLoopSummary
} from "./run-logistics-outbox-loop";

export type ConfiguredLogisticsOutboxLoopWorkerFactory = (
  input: CreateConfiguredLogisticsOutboxWorkerInput
) => ConfiguredLogisticsOutboxWorker;

export type RunConfiguredLogisticsOutboxLoopInput = CreateConfiguredLogisticsOutboxWorkerInput & {
  signal?: AbortSignal;
  idleDelayMs?: number;
  activeDelayMs?: number;
  now?: () => Date;
  sleep?: LogisticsOutboxLoopSleeper;
  workerFactory?: ConfiguredLogisticsOutboxLoopWorkerFactory;
};

export async function runConfiguredLogisticsOutboxLoop(
  input: RunConfiguredLogisticsOutboxLoopInput = {}
): Promise<LogisticsOutboxLoopSummary> {
  const {
    signal,
    idleDelayMs,
    activeDelayMs,
    now,
    sleep,
    workerFactory = createConfiguredLogisticsOutboxWorker,
    ...workerInput
  } = input;
  const worker = workerFactory(workerInput);

  try {
    return await runLogisticsOutboxLoop({
      processor: worker.processor,
      config: worker.config,
      signal,
      idleDelayMs,
      activeDelayMs,
      now,
      sleep
    });
  } finally {
    await worker.close();
  }
}
