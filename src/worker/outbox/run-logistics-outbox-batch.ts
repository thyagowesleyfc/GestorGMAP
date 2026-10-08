import type { LogisticsOutboxWorkerConfig } from "./logistics-outbox-worker-config";
import type { ProcessOutboxEventsResult } from "./process-outbox-events";

export type LogisticsOutboxBatchProcessor = {
  processBatch(options: { batchSize: number; now?: Date }): Promise<ProcessOutboxEventsResult>;
};

export type RunLogisticsOutboxBatchInput = {
  processor: LogisticsOutboxBatchProcessor;
  config: Pick<LogisticsOutboxWorkerConfig, "batchSize">;
  now?: Date;
};

export async function runLogisticsOutboxBatch(
  input: RunLogisticsOutboxBatchInput
): Promise<ProcessOutboxEventsResult> {
  return input.processor.processBatch({
    batchSize: input.config.batchSize,
    now: input.now
  });
}
