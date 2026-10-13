import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";

import type { EmailSender } from "../../src/worker/email/email-sender";
import { createLogisticsOutboxWorker } from "../../src/worker/outbox/create-logistics-outbox-worker";
import { LogisticsDeliveryRegisteredEmailHandler } from "../../src/worker/outbox/logistics-delivery-registered-email-handler";
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

  it("routes delivery registered events through EmailSender and retries sender failures", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-25T20:00:00.000Z");
      const successEvent = await insertOutboxEvent(client, { createdAt: now });
      const failingEvent = await insertOutboxEvent(client, { createdAt: now });
      const sentSubjects: string[] = [];
      const sender: EmailSender = {
        send: async (message) => {
          sentSubjects.push(message.subject);

          if (message.metadata?.eventId === failingEvent) {
            throw new Error("provedor de e-mail indisponivel");
          }
        }
      };
      const handler = new LogisticsDeliveryRegisteredEmailHandler(sender, {
        recipients: ["gmap-logistica@example.test"]
      });
      const worker = new ProcessOutboxEvents(pool, handler);

      const result = await worker.processBatch({
        batchSize: 10,
        now,
        retryPolicy: { maxAttempts: 3, backoffMs: () => 60_000 }
      });

      expect(result).toEqual({ processed: 1, retried: 1, failed: 0 });
      expect(sentSubjects).toEqual([
        "Entrega registrada no GESTOR GMAP: TOTAL",
        "Entrega registrada no GESTOR GMAP: TOTAL"
      ]);
      await expectOutboxState(client, successEvent, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        nextAttemptAt: null,
        lastError: null
      });
      await expectOutboxState(client, failingEvent, {
        status: "PENDING",
        attempts: 1,
        processedAt: null,
        nextAttemptAt: new Date("2026-09-25T20:01:00.000Z"),
        lastError: "provedor de e-mail indisponivel"
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
  it("routes mixed logistics events through configured handlers", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-25T20:40:00.000Z");
      const materialRequestEvent = await insertMaterialRequestFinalizedEvent(client, {
        createdAt: new Date("2026-09-25T20:29:00.000Z")
      });
      const deliveryEvent = await insertOutboxEvent(client, {
        createdAt: new Date("2026-09-25T20:30:00.000Z")
      });
      const recollectionId = randomUUID();
      const recollectionEvent = await insertRecollectionExecutedEvent(client, {
        recollectionId,
        createdAt: new Date("2026-09-25T20:31:00.000Z")
      });
      const sentSubjects: string[] = [];
      const sender: EmailSender = {
        send: async (message) => {
          sentSubjects.push(message.subject);
        }
      };
      const worker = createLogisticsOutboxWorker({
        pool,
        emailSender: sender,
        deliveryEmailRecipients: ["gmap-logistica@example.test"],
        managementTargetTeamContext: "GERENCIA_MATERIAIS"
      });

      const result = await worker.processor.processBatch({ batchSize: 10, now });

      expect(result).toEqual({ processed: 2, retried: 0, failed: 0 });
      expect(sentSubjects).toEqual(["Entrega registrada no GESTOR GMAP: TOTAL"]);
      await expectInternalNotifications(client, [
        {
          title: "Entrega registrada",
          body: `A entrega ${deliveryEvent} foi registrada com aceite TOTAL em 2026-09-25T13:00:00.000Z.`,
          relatedType: "logistics_delivery",
          relatedId: deliveryEvent,
          targetTeamContext: "GERENCIA_MATERIAIS",
          correlationId: `corr-${deliveryEvent}`
        },
        {
          title: "Recolha executada",
          body: `A recolha ${recollectionId} foi executada em 2026-09-25T20:20:00.000Z.`,
          relatedType: "logistics_recollection",
          relatedId: recollectionId,
          targetTeamContext: "GERENCIA_MATERIAIS",
          correlationId: `corr-${recollectionId}`
        }
      ]);
      await worker.handler.handle({
        id: deliveryEvent,
        eventType: "logistics.delivery_registered",
        aggregateType: "logistics_delivery",
        aggregateId: deliveryEvent,
        payload: {
          deliveryId: deliveryEvent,
          shipmentId: "shipment-" + deliveryEvent,
          acceptanceStatus: "TOTAL",
          deliveredAt: "2026-09-25T13:00:00.000Z",
          correlationId: `corr-${deliveryEvent}`
        },
        attempts: 1
      });
      await expectInternalNotifications(client, [
        {
          title: "Entrega registrada",
          body: `A entrega ${deliveryEvent} foi registrada com aceite TOTAL em 2026-09-25T13:00:00.000Z.`,
          relatedType: "logistics_delivery",
          relatedId: deliveryEvent,
          targetTeamContext: "GERENCIA_MATERIAIS",
          correlationId: `corr-${deliveryEvent}`
        },
        {
          title: "Recolha executada",
          body: `A recolha ${recollectionId} foi executada em 2026-09-25T20:20:00.000Z.`,
          relatedType: "logistics_recollection",
          relatedId: recollectionId,
          targetTeamContext: "GERENCIA_MATERIAIS",
          correlationId: `corr-${recollectionId}`
        }
      ]);
      await expectOutboxState(client, deliveryEvent, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        nextAttemptAt: null,
        lastError: null
      });
      await expectOutboxState(client, recollectionEvent, {
        status: "PROCESSED",
        attempts: 0,
        processedAt: now,
        nextAttemptAt: null,
        lastError: null
      });
      await expectOutboxState(client, materialRequestEvent, {
        status: "PENDING",
        attempts: 0,
        processedAt: null,
        nextAttemptAt: null,
        lastError: null
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
  it("retries delivery registered events with invalid notification payload", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const now = new Date("2026-09-25T21:00:00.000Z");
      const deliveryEvent = await insertOutboxEvent(client, {
        createdAt: now,
        payloadOverride: { acceptanceStatus: "PENDENTE" }
      });
      const sender: EmailSender = {
        send: async () => {
          throw new Error("e-mail nao deveria ser enviado");
        }
      };
      const worker = createLogisticsOutboxWorker({
        pool,
        emailSender: sender,
        deliveryEmailRecipients: ["gmap-logistica@example.test"],
        managementTargetTeamContext: "GERENCIA_MATERIAIS"
      });

      const result = await worker.processor.processBatch({
        batchSize: 1,
        now,
        retryPolicy: { maxAttempts: 3, backoffMs: () => 60_000 }
      });

      expect(result).toEqual({ processed: 0, retried: 1, failed: 0 });
      await expectInternalNotificationCount(client, 0);
      await expectOutboxState(client, deliveryEvent, {
        status: "PENDING",
        attempts: 1,
        processedAt: null,
        nextAttemptAt: new Date("2026-09-25T21:01:00.000Z"),
        lastError: "Payload de entrega registrada incompleto."
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
    payloadOverride?: Record<string, unknown>;
  }
): Promise<string> {
  const id = randomUUID();
  const payload = {
    deliveryId: id,
    shipmentId: "shipment-" + id,
    acceptanceStatus: "TOTAL",
    deliveredAt: "2026-09-25T13:00:00.000Z",
    correlationId: "corr-" + id,
    ...input.payloadOverride
  };

  await client.query(
    `insert into "outbox_event" (
      "id", "event_type", "aggregate_type", "aggregate_id", "payload", "attempts", "created_at", "next_attempt_at", "updated_at"
    ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, current_timestamp)`,
    [
      id,
      "logistics.delivery_registered",
      "logistics_delivery",
      id,
      JSON.stringify(payload),
      input.attempts ?? 0,
      input.createdAt ?? new Date("2026-09-25T15:00:00.000Z"),
      input.nextAttemptAt ?? null
    ]
  );

  return id;
}

async function insertRecollectionExecutedEvent(
  client: Client,
  input: {
    recollectionId: string;
    createdAt: Date;
  }
): Promise<string> {
  const id = randomUUID();

  await client.query(
    `insert into "outbox_event" (
      "id", "event_type", "aggregate_type", "aggregate_id", "payload", "created_at", "updated_at"
    ) values ($1, $2, $3, $4, $5::jsonb, $6, current_timestamp)`,
    [
      id,
      "logistics.recollection_executed",
      "logistics_recollection",
      input.recollectionId,
      JSON.stringify({
        recollectionId: input.recollectionId,
        status: "EXECUTADA",
        executedAt: "2026-09-25T20:20:00.000Z",
        correlationId: `corr-${input.recollectionId}`
      }),
      input.createdAt
    ]
  );

  return id;
}

async function insertMaterialRequestFinalizedEvent(
  client: Client,
  input: {
    createdAt: Date;
  }
): Promise<string> {
  const id = randomUUID();
  const materialRequestId = randomUUID();

  await client.query(
    `insert into "outbox_event" (
      "id", "event_type", "aggregate_type", "aggregate_id", "payload", "created_at", "updated_at"
    ) values ($1, $2, $3, $4, $5::jsonb, $6, current_timestamp)`,
    [
      id,
      "requests.material_request_finalized",
      "material_request",
      materialRequestId,
      JSON.stringify({
        materialRequestId,
        status: "FINALIZADA",
        finalizedAt: "2026-09-25T20:10:00.000Z",
        shipmentCount: 1,
        correlationId: `corr-${materialRequestId}`
      }),
      input.createdAt
    ]
  );

  return id;
}

async function expectInternalNotifications(
  client: Client,
  expected: {
    title: string;
    body: string;
    relatedType: string;
    relatedId: string;
    targetTeamContext: string;
    correlationId: string;
  }[]
): Promise<void> {
  const notifications = await client.query<{
    target_type: string;
    target_team_context: string | null;
    status: string;
    title: string;
    body: string;
    related_type: string | null;
    related_id: string | null;
    correlation_id: string;
  }>(
    `select "target_type"::text,
            "target_team_context",
            "status"::text,
            "title",
            "body",
            "related_type",
            "related_id",
            "correlation_id"
       from "internal_notification"
      order by "title", "related_id"`
  );

  expect(notifications.rows).toEqual(
    expected
      .map((notification) => ({
        target_type: "GERENCIA",
        target_team_context: notification.targetTeamContext,
        status: "CRIADA",
        title: notification.title,
        body: notification.body,
        related_type: notification.relatedType,
        related_id: notification.relatedId,
        correlation_id: notification.correlationId
      }))
      .sort((left, right) => {
        const byTitle = left.title.localeCompare(right.title);
        return byTitle === 0 ? left.related_id.localeCompare(right.related_id) : byTitle;
      })
  );
}

async function expectInternalNotificationCount(
  client: Client,
  expectedCount: number
): Promise<void> {
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
