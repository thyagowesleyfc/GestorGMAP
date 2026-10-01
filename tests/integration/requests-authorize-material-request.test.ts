import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AuthorizeMaterialRequest } from "../../src/modules/requests/application/authorize-material-request";
import { PostgresMaterialRequestAuthorizer } from "../../src/modules/requests/infrastructure/postgres-material-request-authorizer";

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

describe("authorize material request", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new AuthorizeMaterialRequest({
      authorize: async () => {
        throw new Error("authorizer should not be called for invalid input");
      }
    });
    const itemId = randomUUID();

    await expect(
      useCase.execute({
        commandId: "  ",
        materialRequestId: randomUUID(),
        authorizations: [{ itemId, authorizedQuantity: 1 }],
        reason: "Analise gerencial"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-autoriza-invalid-001",
        materialRequestId: randomUUID(),
        authorizations: [{ itemId, authorizedQuantity: 1 }],
        reason: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REASON" });

    await expect(
      useCase.execute({
        commandId: "cmd-autoriza-invalid-002",
        materialRequestId: randomUUID(),
        authorizations: [],
        reason: "Analise gerencial"
      })
    ).resolves.toEqual({ ok: false, reason: "EMPTY_AUTHORIZATIONS" });

    await expect(
      useCase.execute({
        commandId: "cmd-autoriza-invalid-003",
        materialRequestId: randomUUID(),
        authorizations: [
          { itemId, authorizedQuantity: 1 },
          { itemId, authorizedQuantity: 1 }
        ],
        reason: "Analise gerencial"
      })
    ).resolves.toEqual({ ok: false, reason: "DUPLICATE_ITEM_AUTHORIZATION", itemId });

    await expect(
      useCase.execute({
        commandId: "cmd-autoriza-invalid-004",
        materialRequestId: randomUUID(),
        authorizations: [{ itemId, authorizedQuantity: -1 }],
        reason: "Analise gerencial"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_AUTHORIZED_QUANTITY", itemId });
  });

  it("authorizes all request items partially and records audit without physical stock effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client);
      const useCase = new AuthorizeMaterialRequest(new PostgresMaterialRequestAuthorizer(pool));
      const command = {
        commandId: "cmd-autoriza-solicitacao-001",
        materialRequestId: seed.materialRequestId,
        authorizations: [
          { itemId: seed.itemIds[0], authorizedQuantity: 3 },
          { itemId: seed.itemIds[1], authorizedQuantity: 0 }
        ],
        analyzedAt: new Date("2026-09-24T16:00:00.000Z"),
        reason: "Autorizacao parcial pela Gerencia",
        correlationId: "corr-autoriza-solicitacao-001"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({
        ok: true,
        materialRequestId: seed.materialRequestId,
        status: "ANALISADA"
      });
      expect(retry).toEqual(first);
      await expectAnalyzedMaterialRequest(client, seed.materialRequestId, seed.itemIds);
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
      await expectNoPhysicalStockEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects idempotency conflicts and invalid authorization sets", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client);
      const otherSeed = await seedMaterialRequest(client);
      const useCase = new AuthorizeMaterialRequest(new PostgresMaterialRequestAuthorizer(pool));

      const first = await useCase.execute({
        commandId: "cmd-autoriza-conflito-001",
        materialRequestId: seed.materialRequestId,
        authorizations: [
          { itemId: seed.itemIds[0], authorizedQuantity: 2 },
          { itemId: seed.itemIds[1], authorizedQuantity: 1 }
        ],
        analyzedAt: new Date("2026-09-24T16:00:00.000Z"),
        reason: "Autorizacao completa"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-autoriza-conflito-001",
        materialRequestId: otherSeed.materialRequestId,
        authorizations: [
          { itemId: otherSeed.itemIds[0], authorizedQuantity: 2 },
          { itemId: otherSeed.itemIds[1], authorizedQuantity: 1 }
        ],
        analyzedAt: new Date("2026-09-24T16:00:00.000Z"),
        reason: "Autorizacao completa"
      });
      const incomplete = await useCase.execute({
        commandId: "cmd-autoriza-incompleta-001",
        materialRequestId: otherSeed.materialRequestId,
        authorizations: [{ itemId: otherSeed.itemIds[0], authorizedQuantity: 2 }],
        analyzedAt: new Date("2026-09-24T16:30:00.000Z"),
        reason: "Autorizacao incompleta"
      });
      const excessive = await useCase.execute({
        commandId: "cmd-autoriza-excessiva-001",
        materialRequestId: otherSeed.materialRequestId,
        authorizations: [
          { itemId: otherSeed.itemIds[0], authorizedQuantity: 6 },
          { itemId: otherSeed.itemIds[1], authorizedQuantity: 1 }
        ],
        analyzedAt: new Date("2026-09-24T16:30:00.000Z"),
        reason: "Autorizacao excessiva"
      });
      const missingItem = await useCase.execute({
        commandId: "cmd-autoriza-item-inexistente-001",
        materialRequestId: otherSeed.materialRequestId,
        authorizations: [
          { itemId: randomUUID(), authorizedQuantity: 1 },
          { itemId: otherSeed.itemIds[1], authorizedQuantity: 1 }
        ],
        analyzedAt: new Date("2026-09-24T16:30:00.000Z"),
        reason: "Autorizacao com item externo"
      });
      const notTriaged = await useCase.execute({
        commandId: "cmd-autoriza-nao-triagem-001",
        materialRequestId: seed.materialRequestId,
        authorizations: [
          { itemId: seed.itemIds[0], authorizedQuantity: 2 },
          { itemId: seed.itemIds[1], authorizedQuantity: 1 }
        ],
        analyzedAt: new Date("2026-09-24T17:00:00.000Z"),
        reason: "Autorizacao repetida"
      });

      expect(first).toEqual({
        ok: true,
        materialRequestId: seed.materialRequestId,
        status: "ANALISADA"
      });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(incomplete).toEqual({
        ok: false,
        reason: "AUTHORIZATION_SET_INCOMPLETE",
        itemId: otherSeed.itemIds[1]
      });
      expect(excessive).toEqual({
        ok: false,
        reason: "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED",
        itemId: otherSeed.itemIds[0]
      });
      expect(missingItem).toEqual({
        ok: false,
        reason: "MATERIAL_REQUEST_ITEM_NOT_FOUND",
        itemId: expect.any(String)
      });
      expect(notTriaged).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_IN_TRIAGEM" });
      await expectTriagedMaterialRequest(client, otherSeed.materialRequestId, otherSeed.itemIds);
      await expectAuditEntries(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
  it("serializes concurrent authorizations for the same request", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client);
      const useCase = new AuthorizeMaterialRequest(new PostgresMaterialRequestAuthorizer(pool));
      const common = {
        materialRequestId: seed.materialRequestId,
        authorizations: [
          { itemId: seed.itemIds[0], authorizedQuantity: 2 },
          { itemId: seed.itemIds[1], authorizedQuantity: 1 }
        ],
        analyzedAt: new Date("2026-09-24T17:30:00.000Z"),
        reason: "Autorizacao concorrente"
      };

      const results = await Promise.all([
        useCase.execute({ ...common, commandId: "cmd-autoriza-concorrente-001" }),
        useCase.execute({ ...common, commandId: "cmd-autoriza-concorrente-002" })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: "MATERIAL_REQUEST_NOT_IN_TRIAGEM" }
      ]);
      await expectAuditEntries(client, 1);
      await expectNoPhysicalStockEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectAnalyzedMaterialRequest(
  client: Client,
  materialRequestId: string,
  itemIds: string[]
): Promise<void> {
  const request = await client.query<{ status: string; version: number }>(
    `select "status"::text, "version"
       from "material_request"
      where "id" = $1`,
    [materialRequestId]
  );
  const items = await client.query<{ id: string; authorized_quantity: number }>(
    `select "id", "authorized_quantity"
       from "material_request_item"
      where "material_request_id" = $1
      order by "line_number"`,
    [materialRequestId]
  );

  expect(request.rows).toEqual([{ status: "ANALISADA", version: 2 }]);
  expect(items.rows).toEqual([
    { id: itemIds[0], authorized_quantity: 3 },
    { id: itemIds[1], authorized_quantity: 0 }
  ]);
}

async function expectTriagedMaterialRequest(
  client: Client,
  materialRequestId: string,
  itemIds: string[]
): Promise<void> {
  const request = await client.query<{ status: string; version: number }>(
    `select "status"::text, "version"
       from "material_request"
      where "id" = $1`,
    [materialRequestId]
  );
  const items = await client.query<{ id: string; authorized_quantity: number | null }>(
    `select "id", "authorized_quantity"
       from "material_request_item"
      where "material_request_id" = $1
      order by "line_number"`,
    [materialRequestId]
  );

  expect(request.rows).toEqual([{ status: "TRIAGEM", version: 1 }]);
  expect(items.rows).toEqual([
    { id: itemIds[0], authorized_quantity: null },
    { id: itemIds[1], authorized_quantity: null }
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
      action: expectedCount === 0 ? null : "requests.authorize_material_request",
      object_type: expectedCount === 0 ? null : "material_request"
    }
  ]);
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
async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'requests.authorize_material_request'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function seedMaterialRequest(
  client: Client
): Promise<{ materialRequestId: string; itemIds: [string, string] }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const firstItemId = randomUUID();
  const secondItemId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-${suffix}`, "GRE Solicitacao Autorizacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, `ENT-${suffix}`, "Escola Solicitante Autorizacao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLA-${suffix}`, "Materiais para autorizacao"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [
      materialSingularId,
      `MAT-${suffix}`,
      "Monitor para autorizacao",
      materialClassId,
      "EQUIPAMENTO"
    ]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "requested_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, current_timestamp)`,
    [
      materialRequestId,
      `SOL-MAT-${suffix}`,
      entityId,
      "2026-09-24T15:30:00.000Z",
      "Solicitacao para autorizacao gerencial"
    ]
  );
  await client.query(
    `insert into "material_request_item" (
      "id", "material_request_id", "line_number", "material_singular_id", "requested_quantity", "updated_at"
    ) values ($1, $2, 1, $3, 5, current_timestamp),
             ($4, $2, 2, $3, 2, current_timestamp)`,
    [firstItemId, materialRequestId, materialSingularId, secondItemId]
  );

  return { materialRequestId, itemIds: [firstItemId, secondItemId] };
}
