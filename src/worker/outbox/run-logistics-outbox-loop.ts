import type { LogisticsOutboxWorkerConfig } from "./logistics-outbox-worker-config";
import type { ProcessOutboxEventsResult } from "./process-outbox-events";
import {
  runLogisticsOutboxBatch,
  type LogisticsOutboxBatchProcessor
} from "./run-logistics-outbox-batch";

export type LogisticsOutboxLoopSummary = ProcessOutboxEventsResult & {
  iterations: number;
};

export type LogisticsOutboxLoopSleeper = (
  durationMs: number,
  signal?: AbortSignal
) => Promise<void>;

export type RunLogisticsOutboxLoopInput = {
  processor: LogisticsOutboxBatchProcessor;
  config: Pick<LogisticsOutboxWorkerConfig, "batchSize">;
  signal?: AbortSignal;
  idleDelayMs?: number;
  activeDelayMs?: number;
  now?: () => Date;
  sleep?: LogisticsOutboxLoopSleeper;
  onBatchResult?: (result: ProcessOutboxEventsResult) => void | Promise<void>;
};

const DEFAULT_IDLE_DELAY_MS = 5_000;
const DEFAULT_ACTIVE_DELAY_MS = 0;

export async function runLogisticsOutboxLoop(
  input: RunLogisticsOutboxLoopInput
): Promise<LogisticsOutboxLoopSummary> {
  const idleDelayMs = normalizeDelay(input.idleDelayMs, "idleDelayMs", DEFAULT_IDLE_DELAY_MS);
  const activeDelayMs = normalizeDelay(
    input.activeDelayMs,
    "activeDelayMs",
    DEFAULT_ACTIVE_DELAY_MS
  );
  const sleep = input.sleep ?? defaultSleep;
  const summary: LogisticsOutboxLoopSummary = {
    iterations: 0,
    processed: 0,
    retried: 0,
    failed: 0
  };

  while (!input.signal?.aborted) {
    const result = await runLogisticsOutboxBatch({
      processor: input.processor,
      config: input.config,
      now: input.now?.()
    });

    summary.iterations += 1;
    summary.processed += result.processed;
    summary.retried += result.retried;
    summary.failed += result.failed;

    await input.onBatchResult?.(result);

    if (input.signal?.aborted) {
      break;
    }

    const delayMs = didBatchDoWork(result) ? activeDelayMs : idleDelayMs;

    if (delayMs > 0) {
      await sleep(delayMs, input.signal);
    }
  }

  return summary;
}

function didBatchDoWork(result: ProcessOutboxEventsResult): boolean {
  return result.processed + result.retried + result.failed > 0;
}

function normalizeDelay(value: number | undefined, name: string, defaultValue: number): number {
  const normalized = value ?? defaultValue;

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${name} deve ser um inteiro maior ou igual a zero.`);
  }

  return normalized;
}

function defaultSleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || durationMs === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, durationMs);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
