import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { LogisticsRecollectionExecutedNotificationHandler } from "../../src/worker/outbox/logistics-recollection-executed-notification-handler";
import { ProcessOutboxEvents } from "../../src/worker/outbox/process-outbox-events";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl
    },
    timeout: 90000
  });
}

describe("logistics recollection executed notification handler", () => {
  it("creates a management notification and marks the outbox event as processed", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-26T17:00:00.000Z");
      const recollectionId = randomUUID();
      const eventId = await insertRecollectionExecutedEvent(client, {
        recollectionId,
        createdAt: now
      });
      const handler = new LogisticsRecollectionExecutedNotificationHandler(pool, {
        targetTeamContext: "GERENCIA_MATERIAIS"
      });
      const worker = new ProcessOutboxEvents(pool, handler);

      const result = await worker.processBatch({ batchSize: 1, now });

      expect(result).toEqual({ processed: 1, retried: 0, failed: 0 });
      await expectNotification(client, {
        recollectionId,
        targetTeamContext: "GERENCIA_MATERIAIS",
        correlationId: `corr-${recollectionId}`
      });

      await handler.handle({
        id: eventId,
        eventType: "logistics.recollection_executed",
        aggregateType: "logistics_recollection",
        aggregateId: recollectionId,
        payload: {
          recollectionId,
          status: "EXECUTADA",
          executedAt: "2026-09-26T15:00:00.000Z",
          correlationId: `corr-${recollectionId}`
        },
        attempts: 1
      });
      await expectNotification(client, {
        recollectionId,
        targetTeamContext: "GERENCIA_MATERIAIS",
        correlationId: `corr-${recollectionId}`
      });
      await expectOutboxState(client, eventId, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        lastError: null
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("retries invalid recollection executed events without creating notifications", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-26T18:00:00.000Z");
      const eventId = await insertRecollectionExecutedEvent(client, {
        recollectionId: randomUUID(),
        createdAt: now,
        payloadOverride: { status: "AUTORIZADA" }
      });
      const handler = new LogisticsRecollectionExecutedNotificationHandler(pool, {
        targetTeamContext: "GERENCIA_MATERIAIS"
      });
      const worker = new ProcessOutboxEvents(pool, handler);

      const result = await worker.processBatch({
        batchSize: 1,
        now,
        retryPolicy: { maxAttempts: 3, backoffMs: () => 60_000 }
      });

      expect(result).toEqual({ processed: 0, retried: 1, failed: 0 });
      await expectNotificationCount(client, 0);
      await expectOutboxState(client, eventId, {
        status: "PENDING",
        attempts: 1,
        processedAt: null,
        nextAttemptAt: new Date("2026-09-26T18:01:00.000Z"),
        lastError: "Payload de recolha executada incompleto."
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function insertRecollectionExecutedEvent(
  client: Client,
  input: {
    recollectionId: string;
    createdAt: Date;
    payloadOverride?: Record<string, unknown>;
  }
): Promise<string> {
  const id = randomUUID();
  const payload = {
    recollectionId: input.recollectionId,
    status: "EXECUTADA",
    executedAt: "2026-09-26T15:00:00.000Z",
    correlationId: `corr-${input.recollectionId}`,
    ...input.payloadOverride
  };

  await client.query(
    `insert into "outbox_event" (
      "id", "event_type", "aggregate_type", "aggregate_id", "payload", "created_at", "updated_at"
    ) values ($1, $2, $3, $4, $5::jsonb, $6, current_timestamp)`,
    [
      id,
      "logistics.recollection_executed",
      "logistics_recollection",
      input.recollectionId,
      JSON.stringify(payload),
      input.createdAt
    ]
  );

  return id;
}

async function expectNotification(
  client: Client,
  input: {
    recollectionId: string;
    targetTeamContext: string;
    correlationId: string;
  }
): Promise<void> {
  const notifications = await client.query<{
    target_type: string;
    target_team_context: string | null;
    status: string;
    title: string;
    body: string;
    action_required: boolean;
    related_type: string | null;
    related_id: string | null;
    correlation_id: string;
  }>(
    `select "target_type"::text,
            "target_team_context",
            "status"::text,
            "title",
            "body",
            "action_required",
            "related_type",
            "related_id",
            "correlation_id"
       from "internal_notification"`
  );

  expect(notifications.rows).toEqual([
    {
      target_type: "GERENCIA",
      target_team_context: input.targetTeamContext,
      status: "CRIADA",
      title: "Recolha executada",
      body: `A recolha ${input.recollectionId} foi executada em 2026-09-26T15:00:00.000Z.`,
      action_required: false,
      related_type: "logistics_recollection",
      related_id: input.recollectionId,
      correlation_id: input.correlationId
    }
  ]);
}

async function expectNotificationCount(client: Client, expectedCount: number): Promise<void> {
  const notifications = await client.query<{ count: number }>(
    `select count(*)::int as count from "internal_notification"`
  );

  expect(notifications.rows).toEqual([{ count: expectedCount }]);
}

async function expectOutboxState(
  client: Client,
  id: string,
  expected: {
    status: "PENDING" | "PROCESSED" | "FAILED";
    attempts: number;
    processedAt: Date | null;
    nextAttemptAt?: Date | null;
    lastError: string | null;
  }
): Promise<void> {
  const events = await client.query<{
    status: string;
    attempts: number;
    processed_at: Date | null;
    next_attempt_at: Date | null;
    last_error: string | null;
  }>(
    `select "status"::text as status,
            "attempts",
            "processed_at",
            "next_attempt_at",
            "last_error"
       from "outbox_event"
      where "id" = $1`,
    [id]
  );

  expect(events.rows).toEqual([
    {
      status: expected.status,
      attempts: expected.attempts,
      processed_at: expected.processedAt,
      next_attempt_at: expected.nextAttemptAt ?? null,
      last_error: expected.lastError
    }
  ]);
}
