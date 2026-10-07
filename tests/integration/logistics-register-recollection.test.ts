import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterLogisticsRecollection } from "../../src/modules/logistics/application/register-logistics-recollection";
import { PostgresLogisticsRecollectionRegistrar } from "../../src/modules/logistics/infrastructure/postgres-logistics-recollection-registrar";

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

describe("register logistics recollection", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new RegisterLogisticsRecollection({
      register: async () => {
        throw new Error("registrar should not be called for invalid input");
      }
    });
    const requestingEntityId = randomUUID();
    const receivingEntityId = randomUUID();

    await expect(
      useCase.execute({
        commandId: "  ",
        code: "REC-CMD-2026-0001",
        requestingEntityId,
        receivingEntityId,
        summary: "Recolha solicitada"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-invalid-code",
        code: "rec-cmd-2026-0001",
        requestingEntityId,
        receivingEntityId,
        summary: "Recolha solicitada"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_RECOLLECTION_CODE" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-invalid-entity",
        code: "REC-CMD-2026-0002",
        requestingEntityId,
        receivingEntityId: requestingEntityId,
        summary: "Recolha solicitada"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_ENTITY" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-invalid-summary",
        code: "REC-CMD-2026-0003",
        requestingEntityId,
        receivingEntityId,
        summary: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_SUMMARY" });
  });

  it("registers a requested recollection idempotently with audit and outbox only", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedRecollectionDependencies(client);
      const useCase = new RegisterLogisticsRecollection(
        new PostgresLogisticsRecollectionRegistrar(pool)
      );
      const command = {
        commandId: "cmd-recolha-registra-001",
        code: "REC-CMD-2026-0001",
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedByUserId: seed.userId,
        requestedAt: new Date("2026-09-26T13:00:00.000Z"),
        summary: "Recolha operacional solicitada pela escola",
        actorUserId: seed.userId,
        teamContext: "CALMOX",
        correlationId: "corr-recolha-registra-001"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toMatchObject({
        ok: true,
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        status: "SOLICITADA"
      });
      expect(retry).toEqual(first);
      if (!first.ok) {
        throw new Error("expected recollection registration to succeed");
      }
      await expectRecollection(client, {
        recollectionId: first.recollectionId,
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedByUserId: seed.userId,
        expectedCount: 1
      });
      await expectAuditEntries(client, 1);
      await expectOutboxEvents(client, {
        recollectionId: first.recollectionId,
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        expectedCount: 1
      });
      await expectIdempotencyRows(client, 1);
      await expectNoDeliveryOrPatrimonyEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects conflicts, duplicate codes and missing references without partial writes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedRecollectionDependencies(client);
      const useCase = new RegisterLogisticsRecollection(
        new PostgresLogisticsRecollectionRegistrar(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-recolha-conflito-001",
        code: "REC-CMD-2026-0100",
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedAt: new Date("2026-09-26T14:00:00.000Z"),
        summary: "Primeira recolha solicitada"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-recolha-conflito-001",
        code: "REC-CMD-2026-0101",
        requestingEntityId: seed.receivingEntityId,
        receivingEntityId: seed.requestingEntityId,
        requestedAt: new Date("2026-09-26T14:00:00.000Z"),
        summary: "Payload divergente"
      });
      const duplicateCode = await useCase.execute({
        commandId: "cmd-recolha-codigo-duplicado-001",
        code: "REC-CMD-2026-0100",
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedAt: new Date("2026-09-26T14:10:00.000Z"),
        summary: "Codigo ja usado"
      });
      const missingEntity = await useCase.execute({
        commandId: "cmd-recolha-entidade-ausente-001",
        code: "REC-CMD-2026-0102",
        requestingEntityId: randomUUID(),
        receivingEntityId: seed.receivingEntityId,
        requestedAt: new Date("2026-09-26T14:20:00.000Z"),
        summary: "Entidade de origem inexistente"
      });
      const missingUser = await useCase.execute({
        commandId: "cmd-recolha-usuario-ausente-001",
        code: "REC-CMD-2026-0103",
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedByUserId: randomUUID(),
        requestedAt: new Date("2026-09-26T14:30:00.000Z"),
        summary: "Usuario solicitante inexistente"
      });

      expect(first).toMatchObject({ ok: true, status: "SOLICITADA" });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(duplicateCode).toEqual({ ok: false, reason: "DUPLICATE_RECOLLECTION_CODE" });
      expect(missingEntity).toMatchObject({ ok: false, reason: "ENTITY_NOT_FOUND" });
      expect(missingUser).toMatchObject({ ok: false, reason: "REQUESTED_BY_USER_NOT_FOUND" });
      await expectTotalRecollections(client, 1);
      await expectAuditEntries(client, 1);
      await expectOutboxEventCount(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectRecollection(
  client: Client,
  input: {
    recollectionId: string;
    requestingEntityId: string;
    receivingEntityId: string;
    requestedByUserId: string;
    expectedCount: number;
  }
): Promise<void> {
  const recollection = await client.query<{
    count: number;
    status: string | null;
    requesting_entity_id: string | null;
    receiving_entity_id: string | null;
    requested_by_user_id: string | null;
  }>(
    `select count(*)::int as count,
            min("status"::text) as status,
            min("requesting_entity_id"::text) as requesting_entity_id,
            min("receiving_entity_id"::text) as receiving_entity_id,
            min("requested_by_user_id"::text) as requested_by_user_id
       from "logistics_recollection"
      where "id" = $1`,
    [input.recollectionId]
  );

  expect(recollection.rows).toEqual([
    {
      count: input.expectedCount,
      status: input.expectedCount === 0 ? null : "SOLICITADA",
      requesting_entity_id: input.expectedCount === 0 ? null : input.requestingEntityId,
      receiving_entity_id: input.expectedCount === 0 ? null : input.receivingEntityId,
      requested_by_user_id: input.expectedCount === 0 ? null : input.requestedByUserId
    }
  ]);
}

async function expectTotalRecollections(client: Client, expectedCount: number): Promise<void> {
  const recollections = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_recollection"`
  );

  expect(recollections.rows).toEqual([{ count: expectedCount }]);
}

async function expectAuditEntries(client: Client, expectedCount: number): Promise<void> {
  const auditEntries = await client.query<{
    count: number;
    action: string | null;
    object_type: string | null;
  }>(
    `select count(*)::int as count,
            min("action") as action,
            min("object_type") as object_type
       from "audit_entry"`
  );

  expect(auditEntries.rows).toEqual([
    {
      count: expectedCount,
      action: expectedCount === 0 ? null : "logistics.register_recollection",
      object_type: expectedCount === 0 ? null : "logistics_recollection"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'logistics.register_recollection'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectOutboxEvents(
  client: Client,
  input: {
    recollectionId: string;
    requestingEntityId: string;
    receivingEntityId: string;
    expectedCount: number;
  }
): Promise<void> {
  const events = await client.query<{
    count: number;
    event_type: string | null;
    aggregate_type: string | null;
    aggregate_id: string | null;
    status: string | null;
    attempts: number | null;
    payload: {
      recollectionId?: string;
      requestingEntityId?: string;
      receivingEntityId?: string;
      status?: string;
    } | null;
  }>(
    `select count(*)::int as count,
            min("event_type") as event_type,
            min("aggregate_type") as aggregate_type,
            min("aggregate_id") as aggregate_id,
            min("status"::text) as status,
            min("attempts")::int as attempts,
            min("payload"::text)::jsonb as payload
       from "outbox_event"
      where "aggregate_id" = $1`,
    [input.recollectionId]
  );

  expect(events.rows).toEqual([
    {
      count: input.expectedCount,
      event_type: input.expectedCount === 0 ? null : "logistics.recollection_registered",
      aggregate_type: input.expectedCount === 0 ? null : "logistics_recollection",
      aggregate_id: input.expectedCount === 0 ? null : input.recollectionId,
      status: input.expectedCount === 0 ? null : "PENDING",
      attempts: input.expectedCount === 0 ? null : 0,
      payload:
        input.expectedCount === 0
          ? null
          : expect.objectContaining({
              recollectionId: input.recollectionId,
              requestingEntityId: input.requestingEntityId,
              receivingEntityId: input.receivingEntityId,
              status: "SOLICITADA"
            })
    }
  ]);
}

async function expectOutboxEventCount(client: Client, expectedCount: number): Promise<void> {
  const events = await client.query<{ count: number }>(
    `select count(*)::int as count from "outbox_event"`
  );

  expect(events.rows).toEqual([{ count: expectedCount }]);
}

async function expectNoDeliveryOrPatrimonyEffects(client: Client): Promise<void> {
  const deliveries = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_delivery"`
  );
  const shipments = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_shipment"`
  );
  const patrimonyTables = await client.query<{ count: number }>(
    `select count(*)::int as count
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('patrimony', 'patrimony_movement', 'patrimony_recollection')`
  );

  expect(deliveries.rows).toEqual([{ count: 0 }]);
  expect(shipments.rows).toEqual([{ count: 0 }]);
  expect(patrimonyTables.rows).toEqual([{ count: 0 }]);
}

type RecollectionSeed = {
  requestingEntityId: string;
  receivingEntityId: string;
  userId: string;
};

async function seedRecollectionDependencies(client: Client): Promise<RecollectionSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const requestingEntityId = randomUUID();
  const receivingEntityId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-REC-${suffix}`, "GRE Recolha Command"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [requestingEntityId, `ENT-ESC-REC-${suffix}`, "Escola Recolha Command", greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [receivingEntityId, `ENT-GER-REC-${suffix}`, "Gerencia Recolha Command", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Pessoa Recolha Command"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "status", "updated_at"
    ) values ($1, $2, $3, 'ACTIVE', current_timestamp)`,
    [userId, personId, `recolha-${suffix.toLowerCase()}@gmap.test`]
  );

  return { requestingEntityId, receivingEntityId, userId };
}
