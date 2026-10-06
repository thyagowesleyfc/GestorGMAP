import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  ProcessOutboxEvents,
  type OutboxEventRecord
} from "../../src/worker/outbox/process-outbox-events";

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

describe("process outbox events", () => {
  it("processes due pending events and leaves future retries untouched", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-25T16:00:00.000Z");
      const dueOne = await insertOutboxEvent(client, {
        createdAt: new Date("2026-09-25T15:00:00.000Z")
      });
      const dueTwo = await insertOutboxEvent(client, {
        createdAt: new Date("2026-09-25T15:01:00.000Z")
      });
      const future = await insertOutboxEvent(client, {
        createdAt: new Date("2026-09-25T15:02:00.000Z"),
        nextAttemptAt: new Date("2026-09-25T17:00:00.000Z")
      });
      const handled: string[] = [];
      const worker = new ProcessOutboxEvents(pool, {
        handle: async (event) => {
          handled.push(event.id);
        }
      });

      const result = await worker.processBatch({ batchSize: 10, now });

      expect(result).toEqual({ processed: 2, retried: 0, failed: 0 });
      expect(handled).toEqual([dueOne, dueTwo]);
      await expectOutboxState(client, dueOne, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        nextAttemptAt: null,
        lastError: null
      });
      await expectOutboxState(client, dueTwo, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        nextAttemptAt: null,
        lastError: null
      });
      await expectOutboxState(client, future, {
        status: "PENDING",
        attempts: 0,
        processedAt: null,
        nextAttemptAt: new Date("2026-09-25T17:00:00.000Z"),
        lastError: null
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("schedules retries and marks failed after the retry limit", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-25T18:00:00.000Z");
      const retryEvent = await insertOutboxEvent(client, { createdAt: now });
      const finalAttempt = await insertOutboxEvent(client, { attempts: 1, createdAt: now });
      const worker = new ProcessOutboxEvents(pool, {
        handle: async () => {
          throw new Error("provedor de e-mail indisponivel");
        }
      });

      const result = await worker.processBatch({
        batchSize: 10,
        now,
        retryPolicy: { maxAttempts: 2, backoffMs: () => 120_000 }
      });

      expect(result).toEqual({ processed: 0, retried: 1, failed: 1 });
      await expectOutboxState(client, retryEvent, {
        status: "PENDING",
        attempts: 1,
        processedAt: null,
        nextAttemptAt: new Date("2026-09-25T18:02:00.000Z"),
        lastError: "provedor de e-mail indisponivel"
      });
      await expectOutboxState(client, finalAttempt, {
        status: "FAILED",
        attempts: 2,
        processedAt: null,
        nextAttemptAt: null,
        lastError: "provedor de e-mail indisponivel"
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("uses database locks so concurrent workers do not process the same event twice", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-25T19:00:00.000Z");
      const eventId = await insertOutboxEvent(client, { createdAt: now });
      const handled: string[] = [];
      const handler = {
        handle: async (event: OutboxEventRecord) => {
          handled.push(event.id);
          await delay(100);
        }
      };
      const firstWorker = new ProcessOutboxEvents(pool, handler);
      const secondWorker = new ProcessOutboxEvents(pool, handler);

      const results = await Promise.all([
        firstWorker.processBatch({ batchSize: 1, now }),
        secondWorker.processBatch({ batchSize: 1, now })
      ]);

      expect(results).toContainEqual({ processed: 1, retried: 0, failed: 0 });
      expect(results).toContainEqual({ processed: 0, retried: 0, failed: 0 });
      expect(handled).toEqual([eventId]);
      await expectOutboxState(client, eventId, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        nextAttemptAt: null,
        lastError: null
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function insertOutboxEvent(
  client: Client,
  input: {
    attempts?: number;
    createdAt?: Date;
    nextAttemptAt?: Date;
  }
): Promise<string> {
  const id = randomUUID();

  await client.query(
    `insert into "outbox_event" (
      "id", "event_type", "aggregate_type", "aggregate_id", "payload", "attempts", "created_at", "next_attempt_at", "updated_at"
    ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, current_timestamp)`,
    [
      id,
      "logistics.delivery_registered",
      "logistics_delivery",
      randomUUID(),
      JSON.stringify({ deliveryId: id, acceptanceStatus: "TOTAL" }),
      input.attempts ?? 0,
      input.createdAt ?? new Date("2026-09-25T15:00:00.000Z"),
      input.nextAttemptAt ?? null
    ]
  );

  return id;
}

async function expectOutboxState(
  client: Client,
  id: string,
  expected: {
    status: "PENDING" | "PROCESSED" | "FAILED";
    attempts: number;
    processedAt: Date | null;
    nextAttemptAt: Date | null;
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
      next_attempt_at: expected.nextAttemptAt,
      last_error: expected.lastError
    }
  ]);
}
