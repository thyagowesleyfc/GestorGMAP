import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { DispatchMaterialRequest } from "../../src/modules/requests/application/dispatch-material-request";
import { PostgresMaterialRequestDispatcher } from "../../src/modules/requests/infrastructure/postgres-material-request-dispatcher";

const execFileAsync = promisify(execFile);

type MaterialRequestStatus = "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";

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

describe("dispatch material request", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new DispatchMaterialRequest({
      dispatch: async () => {
        throw new Error("dispatcher should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        materialRequestId: randomUUID(),
        reason: "Encaminhamento para atendimento"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-despacha-invalid-001",
        materialRequestId: randomUUID(),
        reason: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REASON" });
  });

  it("dispatches an analyzed request idempotently without physical stock effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client, { status: "ANALISADA", authorized: true });
      const useCase = new DispatchMaterialRequest(new PostgresMaterialRequestDispatcher(pool));
      const command = {
        commandId: "cmd-despacha-solicitacao-001",
        materialRequestId: seed.materialRequestId,
        dispatchedAt: new Date("2026-09-24T18:00:00.000Z"),
        reason: "Encaminhamento da Triagem ao Almoxarifado",
        correlationId: "corr-despacha-solicitacao-001"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({
        ok: true,
        materialRequestId: seed.materialRequestId,
        status: "DESPACHADA"
      });
      expect(retry).toEqual(first);
      await expectDispatchedMaterialRequest(client, seed.materialRequestId);
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
      await expectNoPhysicalStockEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects idempotency conflicts, incomplete authorization and non-analyzed requests", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const analyzed = await seedMaterialRequest(client, { status: "ANALISADA", authorized: true });
      const otherAnalyzed = await seedMaterialRequest(client, {
        status: "ANALISADA",
        authorized: true
      });
      const incomplete = await seedMaterialRequest(client, {
        status: "ANALISADA",
        authorized: false
      });
      const useCase = new DispatchMaterialRequest(new PostgresMaterialRequestDispatcher(pool));

      const first = await useCase.execute({
        commandId: "cmd-despacha-conflito-001",
        materialRequestId: analyzed.materialRequestId,
        dispatchedAt: new Date("2026-09-24T18:00:00.000Z"),
        reason: "Encaminhamento ao Almoxarifado"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-despacha-conflito-001",
        materialRequestId: otherAnalyzed.materialRequestId,
        dispatchedAt: new Date("2026-09-24T18:00:00.000Z"),
        reason: "Encaminhamento ao Almoxarifado"
      });
      const incompleteResult = await useCase.execute({
        commandId: "cmd-despacha-incompleta-001",
        materialRequestId: incomplete.materialRequestId,
        dispatchedAt: new Date("2026-09-24T18:30:00.000Z"),
        reason: "Tentativa sem todas as decisoes"
      });
      const missing = await useCase.execute({
        commandId: "cmd-despacha-inexistente-001",
        materialRequestId: randomUUID(),
        dispatchedAt: new Date("2026-09-24T18:30:00.000Z"),
        reason: "Solicitacao inexistente"
      });

      expect(first).toEqual({
        ok: true,
        materialRequestId: analyzed.materialRequestId,
        status: "DESPACHADA"
      });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(incompleteResult).toEqual({ ok: false, reason: "AUTHORIZATION_SET_INCOMPLETE" });
      expect(missing).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_FOUND" });

      for (const status of ["TRIAGEM", "NOVA", "DESPACHADA", "FINALIZADA"] as const) {
        const seed = await seedMaterialRequest(client, { status, authorized: true });
        await expect(
          useCase.execute({
            commandId: `cmd-despacha-estado-${status.toLowerCase()}`,
            materialRequestId: seed.materialRequestId,
            dispatchedAt: new Date("2026-09-24T18:30:00.000Z"),
            reason: "Estado nao despachavel"
          })
        ).resolves.toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_ANALYZED" });
      }

      await expectAnalyzedMaterialRequest(client, otherAnalyzed.materialRequestId);
      await expectAnalyzedMaterialRequest(client, incomplete.materialRequestId);
      await expectAuditEntries(client, 1);
      await expectNoPhysicalStockEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializes concurrent dispatches for the same request", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client, { status: "ANALISADA", authorized: true });
      const useCase = new DispatchMaterialRequest(new PostgresMaterialRequestDispatcher(pool));
      const common = {
        materialRequestId: seed.materialRequestId,
        dispatchedAt: new Date("2026-09-24T19:00:00.000Z"),
        reason: "Despacho concorrente"
      };

      const results = await Promise.all([
        useCase.execute({ ...common, commandId: "cmd-despacha-concorrente-001" }),
        useCase.execute({ ...common, commandId: "cmd-despacha-concorrente-002" })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: "MATERIAL_REQUEST_NOT_ANALYZED" }
      ]);
      await expectDispatchedMaterialRequest(client, seed.materialRequestId);
      await expectAuditEntries(client, 1);
      await expectNoPhysicalStockEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectDispatchedMaterialRequest(
  client: Client,
  materialRequestId: string
): Promise<void> {
  const request = await client.query<{ status: string; version: number }>(
    `select "status"::text, "version"
       from "material_request"
      where "id" = $1`,
    [materialRequestId]
  );

  expect(request.rows).toEqual([{ status: "DESPACHADA", version: 3 }]);
}

async function expectAnalyzedMaterialRequest(
  client: Client,
  materialRequestId: string
): Promise<void> {
  const request = await client.query<{ status: string; version: number }>(
    `select "status"::text, "version"
       from "material_request"
      where "id" = $1`,
    [materialRequestId]
  );

  expect(request.rows).toEqual([{ status: "ANALISADA", version: 2 }]);
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
      action: expectedCount === 0 ? null : "requests.dispatch_material_request",
      object_type: expectedCount === 0 ? null : "material_request"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'requests.dispatch_material_request'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectNoPhysicalStockEffects(client: Client): Promise<void> {
  const stockEffects = await client.query<{
    reservations: number;
    separations: number;
    movements: number;
  }>(
    `select
       (select count(*)::int from "stock_reservation") as reservations,
       (select count(*)::int from "stock_separation") as separations,
       (select count(*)::int from "stock_movement") as movements`
  );

  expect(stockEffects.rows).toEqual([{ reservations: 0, separations: 0, movements: 0 }]);
}

async function seedMaterialRequest(
  client: Client,
  input: { status: MaterialRequestStatus; authorized: boolean }
): Promise<{ materialRequestId: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const firstItemId = randomUUID();
  const secondItemId = randomUUID();
  const version = input.status === "ANALISADA" ? 2 : 1;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-${suffix}`, "GRE Despacho Solicitacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, `ENT-${suffix}`, "Escola Despacho Solicitacao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLD-${suffix}`, "Materiais para despacho"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, `MAT-${suffix}`, "Monitor para despacho", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      materialRequestId,
      `SOL-MAT-${suffix}`,
      entityId,
      input.status,
      "2026-09-24T17:30:00.000Z",
      "Solicitacao para despacho da triagem",
      version
    ]
  );
  await client.query(
    `insert into "material_request_item" (
      "id", "material_request_id", "line_number", "material_singular_id", "requested_quantity", "authorized_quantity", "updated_at"
    ) values ($1, $2, 1, $3, 5, $4, current_timestamp),
             ($5, $2, 2, $3, 2, $6, current_timestamp)`,
    [
      firstItemId,
      materialRequestId,
      materialSingularId,
      input.authorized ? 3 : null,
      secondItemId,
      input.authorized ? 0 : null
    ]
  );

  return { materialRequestId };
}
