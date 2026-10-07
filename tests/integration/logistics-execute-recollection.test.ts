import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { ExecuteLogisticsRecollection } from "../../src/modules/logistics/application/execute-logistics-recollection";
import { PostgresLogisticsRecollectionExecutor } from "../../src/modules/logistics/infrastructure/postgres-logistics-recollection-executor";

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

describe("execute logistics recollection", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new ExecuteLogisticsRecollection({
      execute: async () => {
        throw new Error("executor should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        recollectionId: randomUUID(),
        summary: "Recolha executada"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-exec-invalid-id",
        recollectionId: " ",
        summary: "Recolha executada"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_RECOLLECTION_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-exec-invalid-summary",
        recollectionId: randomUUID(),
        summary: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_SUMMARY" });
  });

  it("executes an authorized recollection idempotently with audit and outbox only", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedRecollectionDependencies(client, { status: "AUTORIZADA" });
      const useCase = new ExecuteLogisticsRecollection(
        new PostgresLogisticsRecollectionExecutor(pool)
      );
      const command = {
        commandId: "cmd-recolha-executa-001",
        recollectionId: seed.recollectionId,
        executedAt: new Date("2026-09-26T15:00:00.000Z"),
        summary: "Recolha operacional executada pelo almoxarifado e logistica",
        actorUserId: seed.userId,
        teamContext: "ALMOXARIFADO_LOGISTICA",
        correlationId: "corr-recolha-executa-001"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({
        ok: true,
        recollectionId: seed.recollectionId,
        status: "EXECUTADA"
      });
      expect(retry).toEqual(first);
      await expectExecutedRecollection(client, seed.recollectionId);
      await expectAuditEntries(client, 1);
      await expectOutboxEvents(client, {
        recollectionId: seed.recollectionId,
        expectedCount: 1
      });
      await expectIdempotencyRows(client, 1);
      await expectNoPatrimonyEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects conflicts, invalid states and invalid execution dates without partial writes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const authorized = await seedRecollectionDependencies(client, { status: "AUTORIZADA" });
      const otherAuthorized = await seedRecollectionDependencies(client, { status: "AUTORIZADA" });
      const requested = await seedRecollectionDependencies(client, { status: "SOLICITADA" });
      const executed = await seedRecollectionDependencies(client, { status: "EXECUTADA" });
      const useCase = new ExecuteLogisticsRecollection(
        new PostgresLogisticsRecollectionExecutor(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-recolha-executa-conflito-001",
        recollectionId: authorized.recollectionId,
        executedAt: new Date("2026-09-26T15:30:00.000Z"),
        summary: "Primeira execucao operacional"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-recolha-executa-conflito-001",
        recollectionId: otherAuthorized.recollectionId,
        executedAt: new Date("2026-09-26T15:30:00.000Z"),
        summary: "Payload divergente"
      });
      const missing = await useCase.execute({
        commandId: "cmd-recolha-executa-ausente-001",
        recollectionId: randomUUID(),
        executedAt: new Date("2026-09-26T15:40:00.000Z"),
        summary: "Recolha inexistente"
      });
      const notAuthorized = await useCase.execute({
        commandId: "cmd-recolha-executa-status-001",
        recollectionId: requested.recollectionId,
        executedAt: new Date("2026-09-26T15:50:00.000Z"),
        summary: "Recolha ainda nao autorizada"
      });
      const alreadyExecuted = await useCase.execute({
        commandId: "cmd-recolha-executa-repetida-001",
        recollectionId: executed.recollectionId,
        executedAt: new Date("2026-09-26T16:00:00.000Z"),
        summary: "Recolha ja executada"
      });
      const beforeAuthorization = await useCase.execute({
        commandId: "cmd-recolha-executa-data-001",
        recollectionId: otherAuthorized.recollectionId,
        executedAt: new Date("2026-09-26T12:30:00.000Z"),
        summary: "Execucao anterior a autorizacao"
      });

      expect(first).toEqual({
        ok: true,
        recollectionId: authorized.recollectionId,
        status: "EXECUTADA"
      });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(missing).toMatchObject({ ok: false, reason: "RECOLLECTION_NOT_FOUND" });
      expect(notAuthorized).toEqual({
        ok: false,
        reason: "RECOLLECTION_NOT_AUTHORIZED",
        recollectionId: requested.recollectionId
      });
      expect(alreadyExecuted).toEqual({
        ok: false,
        reason: "RECOLLECTION_NOT_AUTHORIZED",
        recollectionId: executed.recollectionId
      });
      expect(beforeAuthorization).toEqual({
        ok: false,
        reason: "EXECUTION_DATE_BEFORE_AUTHORIZATION",
        recollectionId: otherAuthorized.recollectionId
      });
      await expectExecutedRecollection(client, authorized.recollectionId);
      await expectAuthorizedRecollection(client, otherAuthorized.recollectionId);
      await expectRequestedRecollection(client, requested.recollectionId);
      await expectAuditEntries(client, 1);
      await expectOutboxEventCount(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializes concurrent executions for the same authorized recollection", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedRecollectionDependencies(client, { status: "AUTORIZADA" });
      const useCase = new ExecuteLogisticsRecollection(
        new PostgresLogisticsRecollectionExecutor(pool)
      );
      const common = {
        recollectionId: seed.recollectionId,
        executedAt: new Date("2026-09-26T16:00:00.000Z"),
        summary: "Execucao operacional concorrente"
      };

      const results = await Promise.all([
        useCase.execute({ ...common, commandId: "cmd-recolha-executa-concorrente-001" }),
        useCase.execute({ ...common, commandId: "cmd-recolha-executa-concorrente-002" })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "RECOLLECTION_NOT_AUTHORIZED",
          recollectionId: seed.recollectionId
        }
      ]);
      await expectExecutedRecollection(client, seed.recollectionId);
      await expectAuditEntries(client, 1);
      await expectOutboxEventCount(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectExecutedRecollection(client: Client, recollectionId: string): Promise<void> {
  const recollection = await client.query<{
    status: string;
    executed_at: Date | null;
    version: number;
  }>(
    `select "status"::text, "executed_at", "version"
       from "logistics_recollection"
      where "id" = $1`,
    [recollectionId]
  );

  expect(recollection.rows).toEqual([
    {
      status: "EXECUTADA",
      executed_at: expect.any(Date),
      version: 3
    }
  ]);
}

async function expectAuthorizedRecollection(client: Client, recollectionId: string): Promise<void> {
  const recollection = await client.query<{
    status: string;
    executed_at: Date | null;
    version: number;
  }>(
    `select "status"::text, "executed_at", "version"
       from "logistics_recollection"
      where "id" = $1`,
    [recollectionId]
  );

  expect(recollection.rows).toEqual([
    {
      status: "AUTORIZADA",
      executed_at: null,
      version: 2
    }
  ]);
}

async function expectRequestedRecollection(client: Client, recollectionId: string): Promise<void> {
  const recollection = await client.query<{
    status: string;
    executed_at: Date | null;
    version: number;
  }>(
    `select "status"::text, "executed_at", "version"
       from "logistics_recollection"
      where "id" = $1`,
    [recollectionId]
  );

  expect(recollection.rows).toEqual([
    {
      status: "SOLICITADA",
      executed_at: null,
      version: 1
    }
  ]);
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
      action: expectedCount === 0 ? null : "logistics.execute_recollection",
      object_type: expectedCount === 0 ? null : "logistics_recollection"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'logistics.execute_recollection'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectOutboxEvents(
  client: Client,
  input: {
    recollectionId: string;
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
      event_type: input.expectedCount === 0 ? null : "logistics.recollection_executed",
      aggregate_type: input.expectedCount === 0 ? null : "logistics_recollection",
      aggregate_id: input.expectedCount === 0 ? null : input.recollectionId,
      status: input.expectedCount === 0 ? null : "PENDING",
      attempts: input.expectedCount === 0 ? null : 0,
      payload:
        input.expectedCount === 0
          ? null
          : expect.objectContaining({
              recollectionId: input.recollectionId,
              status: "EXECUTADA"
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

async function expectNoPatrimonyEffects(client: Client): Promise<void> {
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
  recollectionId: string;
  userId: string;
};

async function seedRecollectionDependencies(
  client: Client,
  input: { status: "SOLICITADA" | "AUTORIZADA" | "EXECUTADA" }
): Promise<RecollectionSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const requestingEntityId = randomUUID();
  const receivingEntityId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();
  const recollectionId = randomUUID();
  const requestedAt = new Date("2026-09-26T12:00:00.000Z");
  const authorizedAt =
    input.status === "AUTORIZADA" || input.status === "EXECUTADA"
      ? new Date("2026-09-26T13:00:00.000Z")
      : null;
  const executedAt = input.status === "EXECUTADA" ? new Date("2026-09-26T14:00:00.000Z") : null;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-REX-${suffix}`, "GRE Recolha Execucao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [requestingEntityId, `ENT-ESC-REX-${suffix}`, "Escola Recolha Execucao", greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [receivingEntityId, `ENT-GER-REX-${suffix}`, "Gerencia Recolha Execucao", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Pessoa Recolha Execucao"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "status", "updated_at"
    ) values ($1, $2, $3, 'ACTIVE', current_timestamp)`,
    [userId, personId, `recolha-exec-${suffix.toLowerCase()}@gmap.test`]
  );
  await client.query(
    `insert into "logistics_recollection" (
      "id", "code", "requesting_entity_id", "receiving_entity_id", "requested_by_user_id",
      "status", "requested_at", "authorized_at", "executed_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_timestamp)`,
    [
      recollectionId,
      `REC-EXEC-${suffix}`,
      requestingEntityId,
      receivingEntityId,
      userId,
      input.status,
      requestedAt,
      authorizedAt,
      executedAt,
      "Recolha para execucao operacional",
      input.status === "EXECUTADA" ? 3 : input.status === "AUTORIZADA" ? 2 : 1
    ]
  );

  return { recollectionId, userId };
}
