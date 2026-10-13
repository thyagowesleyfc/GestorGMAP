import {
  createConfiguredLogisticsOutboxWorker,
  type ConfiguredLogisticsOutboxWorker,
  type CreateConfiguredLogisticsOutboxWorkerInput
} from "./create-configured-logistics-outbox-worker";
import type { ProcessOutboxEventsResult } from "./process-outbox-events";
import { runLogisticsOutboxBatch } from "./run-logistics-outbox-batch";

export type ConfiguredLogisticsOutboxWorkerFactory = (
  input: CreateConfiguredLogisticsOutboxWorkerInput
) => ConfiguredLogisticsOutboxWorker;

export type RunConfiguredLogisticsOutboxBatchInput = CreateConfiguredLogisticsOutboxWorkerInput & {
  now?: Date;
  workerFactory?: ConfiguredLogisticsOutboxWorkerFactory;
};

export async function runConfiguredLogisticsOutboxBatch(
  input: RunConfiguredLogisticsOutboxBatchInput = {}
): Promise<ProcessOutboxEventsResult> {
  const { now, workerFactory = createConfiguredLogisticsOutboxWorker, ...workerInput } = input;
  const worker = workerFactory(workerInput);

  try {
    return await runLogisticsOutboxBatch({
      processor: worker.processor,
      config: worker.config,
      now
    });
  } finally {
    await worker.close();
  }
}
