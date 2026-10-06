import { Pool, type PoolClient } from "pg";

export type OutboxEventRecord = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
};

export type OutboxEventHandler = {
  handle(event: OutboxEventRecord): Promise<void>;
};

export type OutboxRetryPolicy = {
  maxAttempts: number;
  backoffMs(attempt: number): number;
};

export type ProcessOutboxEventsOptions = {
  batchSize?: number;
  now?: Date;
  retryPolicy?: OutboxRetryPolicy;
};

export type ProcessOutboxEventsResult = {
  processed: number;
  retried: number;
  failed: number;
};

type OutboxEventRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_POLICY: OutboxRetryPolicy = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  backoffMs: (attempt) => Math.min(60_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000)
};

export class ProcessOutboxEvents {
  constructor(
    private readonly pool: Pool,
    private readonly handler: OutboxEventHandler
  ) {}

  async processBatch(options: ProcessOutboxEventsOptions = {}): Promise<ProcessOutboxEventsResult> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const now = options.now ?? new Date();
    const result: ProcessOutboxEventsResult = { processed: 0, retried: 0, failed: 0 };

    if (batchSize <= 0) {
      return result;
    }

    for (let index = 0; index < batchSize; index += 1) {
      const outcome = await this.processNext(now, retryPolicy);

      if (outcome === "NONE") {
        break;
      }

      result[outcome] += 1;
    }

    return result;
  }

  private async processNext(
    now: Date,
    retryPolicy: OutboxRetryPolicy
  ): Promise<keyof ProcessOutboxEventsResult | "NONE"> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const event = await this.claimNext(client, now);

      if (event === null) {
        await client.query("commit");
        return "NONE";
      }

      try {
        await this.handler.handle(toOutboxEventRecord(event));
        await markProcessed(client, event.id, now);
        await client.query("commit");
        return "processed";
      } catch (error) {
        const nextAttempts = event.attempts + 1;
        const lastError = formatLastError(error);

        if (nextAttempts >= retryPolicy.maxAttempts) {
          await markFailed(client, event.id, nextAttempts, lastError, now);
          await client.query("commit");
          return "failed";
        }

        await markRetry(client, {
          id: event.id,
          attempts: nextAttempts,
          lastError,
          nextAttemptAt: new Date(now.getTime() + retryPolicy.backoffMs(nextAttempts))
        });
        await client.query("commit");
        return "retried";
      }
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async claimNext(client: PoolClient, now: Date): Promise<OutboxEventRow | null> {
    const events = await client.query<OutboxEventRow>(
      `select "id", "event_type", "aggregate_type", "aggregate_id", "payload", "attempts"
         from "outbox_event"
        where "status" = 'PENDING'
          and ("next_attempt_at" is null or "next_attempt_at" <= $1)
        order by "created_at", "id"
        limit 1
        for update skip locked`,
      [now]
    );

    return events.rows[0] ?? null;
  }
}

function toOutboxEventRecord(row: OutboxEventRow): OutboxEventRecord {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    attempts: row.attempts
  };
}

async function markProcessed(client: PoolClient, id: string, processedAt: Date): Promise<void> {
  await client.query(
    `update "outbox_event"
        set "status" = 'PROCESSED',
            "processed_at" = $2,
            "last_error" = null,
            "next_attempt_at" = null,
            "updated_at" = current_timestamp
      where "id" = $1`,
    [id, processedAt]
  );
}

async function markRetry(
  client: PoolClient,
  input: {
    id: string;
    attempts: number;
    lastError: string;
    nextAttemptAt: Date;
  }
): Promise<void> {
  await client.query(
    `update "outbox_event"
        set "attempts" = $2,
            "last_error" = $3,
            "next_attempt_at" = $4,
            "updated_at" = current_timestamp
      where "id" = $1`,
    [input.id, input.attempts, input.lastError, input.nextAttemptAt]
  );
}

async function markFailed(
  client: PoolClient,
  id: string,
  attempts: number,
  lastError: string,
  failedAt: Date
): Promise<void> {
  await client.query(
    `update "outbox_event"
        set "status" = 'FAILED',
            "attempts" = $2,
            "last_error" = $3,
            "next_attempt_at" = null,
            "updated_at" = $4
      where "id" = $1`,
    [id, attempts, lastError, failedAt]
  );
}

function formatLastError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 1000);
  }

  return "Erro desconhecido ao processar evento da Outbox.";
}
