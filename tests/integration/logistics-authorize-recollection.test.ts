import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AuthorizeLogisticsRecollection } from "../../src/modules/logistics/application/authorize-logistics-recollection";
import { PostgresLogisticsRecollectionAuthorizer } from "../../src/modules/logistics/infrastructure/postgres-logistics-recollection-authorizer";

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

describe("authorize logistics recollection", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new AuthorizeLogisticsRecollection({
      authorize: async () => {
        throw new Error("authorizer should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        recollectionId: randomUUID(),
        reason: "Autorizacao operacional"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-auth-invalid-id",
        recollectionId: " ",
        reason: "Autorizacao operacional"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_RECOLLECTION_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-rec-auth-invalid-reason",
        recollectionId: randomUUID(),
        reason: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REASON" });
  });

  it("authorizes a requested recollection idempotently with audit and outbox only", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedRecollectionDependencies(client, { status: "SOLICITADA" });
      const useCase = new AuthorizeLogisticsRecollection(
        new PostgresLogisticsRecollectionAuthorizer(pool)
      );
      const command = {
        commandId: "cmd-recolha-autoriza-001",
        recollectionId: seed.recollectionId,
        authorizedAt: new Date("2026-09-26T15:00:00.000Z"),
        reason: "Autorizacao operacional pela Coordenacao CALMOX",
        actorUserId: seed.userId,
        teamContext: "CALMOX",
        correlationId: "corr-recolha-autoriza-001"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({
        ok: true,
        recollectionId: seed.recollectionId,
        status: "AUTORIZADA"
      });
      expect(retry).toEqual(first);
      await expectAuthorizedRecollection(client, seed.recollectionId);
      await expectAuditEntries(client, 1);
      await expectOutboxEvents(client, {
        recollectionId: seed.recollectionId,
        expectedCount: 1
      });
      await expectIdempotencyRows(client, 1);
      await expectNoExecutionOrPatrimonyEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects conflicts, invalid states and invalid authorization dates without partial writes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const requested = await seedRecollectionDependencies(client, { status: "SOLICITADA" });
      const otherRequested = await seedRecollectionDependencies(client, { status: "SOLICITADA" });
      const alreadyAuthorized = await seedRecollectionDependencies(client, {
        status: "AUTORIZADA"
      });
      const useCase = new AuthorizeLogisticsRecollection(
        new PostgresLogisticsRecollectionAuthorizer(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-recolha-autoriza-conflito-001",
        recollectionId: requested.recollectionId,
        authorizedAt: new Date("2026-09-26T15:30:00.000Z"),
        reason: "Primeira autorizacao operacional"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-recolha-autoriza-conflito-001",
        recollectionId: otherRequested.recollectionId,
        authorizedAt: new Date("2026-09-26T15:30:00.000Z"),
        reason: "Payload divergente"
      });
      const missing = await useCase.execute({
        commandId: "cmd-recolha-autoriza-ausente-001",
        recollectionId: randomUUID(),
        authorizedAt: new Date("2026-09-26T15:40:00.000Z"),
        reason: "Recolha inexistente"
      });
      const notRequested = await useCase.execute({
        commandId: "cmd-recolha-autoriza-status-001",
        recollectionId: alreadyAuthorized.recollectionId,
        authorizedAt: new Date("2026-09-26T15:50:00.000Z"),
        reason: "Recolha ja autorizada"
      });
      const beforeRequest = await useCase.execute({
        commandId: "cmd-recolha-autoriza-data-001",
        recollectionId: otherRequested.recollectionId,
        authorizedAt: new Date("2026-09-26T11:00:00.000Z"),
        reason: "Autorizacao anterior a solicitacao"
      });

      expect(first).toEqual({
        ok: true,
        recollectionId: requested.recollectionId,
        status: "AUTORIZADA"
      });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(missing).toMatchObject({ ok: false, reason: "RECOLLECTION_NOT_FOUND" });
      expect(notRequested).toEqual({
        ok: false,
        reason: "RECOLLECTION_NOT_REQUESTED",
        recollectionId: alreadyAuthorized.recollectionId
      });
      expect(beforeRequest).toEqual({
        ok: false,
        reason: "AUTHORIZATION_DATE_BEFORE_REQUEST",
        recollectionId: otherRequested.recollectionId
      });
      await expectAuthorizedRecollection(client, requested.recollectionId);
      await expectRequestedRecollection(client, otherRequested.recollectionId);
      await expectAuditEntries(client, 1);
      await expectOutboxEventCount(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializes concurrent authorizations for the same requested recollection", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedRecollectionDependencies(client, { status: "SOLICITADA" });
      const useCase = new AuthorizeLogisticsRecollection(
        new PostgresLogisticsRecollectionAuthorizer(pool)
      );
      const common = {
        recollectionId: seed.recollectionId,
        authorizedAt: new Date("2026-09-26T16:00:00.000Z"),
        reason: "Autorizacao operacional concorrente"
      };

      const results = await Promise.all([
        useCase.execute({ ...common, commandId: "cmd-recolha-autoriza-concorrente-001" }),
        useCase.execute({ ...common, commandId: "cmd-recolha-autoriza-concorrente-002" })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "RECOLLECTION_NOT_REQUESTED",
          recollectionId: seed.recollectionId
        }
      ]);
      await expectAuthorizedRecollection(client, seed.recollectionId);
      await expectAuditEntries(client, 1);
      await expectOutboxEventCount(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectAuthorizedRecollection(client: Client, recollectionId: string): Promise<void> {
  const recollection = await client.query<{
    status: string;
    authorized_at: Date | null;
    version: number;
  }>(
    `select "status"::text, "authorized_at", "version"
       from "logistics_recollection"
      where "id" = $1`,
    [recollectionId]
  );

  expect(recollection.rows).toEqual([
    {
      status: "AUTORIZADA",
      authorized_at: expect.any(Date),
      version: 2
    }
  ]);
}

async function expectRequestedRecollection(client: Client, recollectionId: string): Promise<void> {
  const recollection = await client.query<{
    status: string;
    authorized_at: Date | null;
    version: number;
  }>(
    `select "status"::text, "authorized_at", "version"
       from "logistics_recollection"
      where "id" = $1`,
    [recollectionId]
  );

  expect(recollection.rows).toEqual([
    {
      status: "SOLICITADA",
      authorized_at: null,
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
      action: expectedCount === 0 ? null : "logistics.authorize_recollection",
      object_type: expectedCount === 0 ? null : "logistics_recollection"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'logistics.authorize_recollection'`
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
      event_type: input.expectedCount === 0 ? null : "logistics.recollection_authorized",
      aggregate_type: input.expectedCount === 0 ? null : "logistics_recollection",
      aggregate_id: input.expectedCount === 0 ? null : input.recollectionId,
      status: input.expectedCount === 0 ? null : "PENDING",
      attempts: input.expectedCount === 0 ? null : 0,
      payload:
        input.expectedCount === 0
          ? null
          : expect.objectContaining({
              recollectionId: input.recollectionId,
              status: "AUTORIZADA"
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

async function expectNoExecutionOrPatrimonyEffects(client: Client): Promise<void> {
  const executed = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "logistics_recollection"
      where "status" = 'EXECUTADA'
         or "executed_at" is not null`
  );
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

  expect(executed.rows).toEqual([{ count: 0 }]);
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
  input: { status: "SOLICITADA" | "AUTORIZADA" }
): Promise<RecollectionSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const requestingEntityId = randomUUID();
  const receivingEntityId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();
  const recollectionId = randomUUID();
  const requestedAt = new Date("2026-09-26T12:00:00.000Z");
  const authorizedAt = input.status === "AUTORIZADA" ? new Date("2026-09-26T13:00:00.000Z") : null;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-RAU-${suffix}`, "GRE Recolha Autorizacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [requestingEntityId, `ENT-ESC-RAU-${suffix}`, "Escola Recolha Autorizacao", greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [receivingEntityId, `ENT-GER-RAU-${suffix}`, "Gerencia Recolha Autorizacao", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Pessoa Recolha Autorizacao"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "status", "updated_at"
    ) values ($1, $2, $3, 'ACTIVE', current_timestamp)`,
    [userId, personId, `recolha-auth-${suffix.toLowerCase()}@gmap.test`]
  );
  await client.query(
    `insert into "logistics_recollection" (
      "id", "code", "requesting_entity_id", "receiving_entity_id", "requested_by_user_id",
      "status", "requested_at", "authorized_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
    [
      recollectionId,
      `REC-AUTH-${suffix}`,
      requestingEntityId,
      receivingEntityId,
      userId,
      input.status,
      requestedAt,
      authorizedAt,
      "Recolha para autorizacao operacional",
      input.status === "AUTORIZADA" ? 2 : 1
    ]
  );

  return { recollectionId, userId };
}
