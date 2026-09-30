import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegularizeReceivingStock } from "../../src/modules/stock/application/regularize-receiving-stock";
import { PostgresReceivingStockRegularizer } from "../../src/modules/stock/infrastructure/postgres-receiving-stock-regularizer";

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

describe("regularize receiving stock", () => {
  it("creates regularization, movement, stock position and audit atomically", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedReceivingStock(client, [3, 2]);
      const useCase = new RegularizeReceivingStock(new PostgresReceivingStockRegularizer(pool));
      const regularizedAt = new Date("2026-09-23T19:00:00.000Z");

      const first = await useCase.execute({
        commandId: "cmd-entrada-recebimento-001",
        movementCode: "EST-CMD-0001",
        receivingEntryItemId: seed.receivingEntryItemIds[0],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Entrada regularizada de monitores",
        regularizedByUserId: seed.userId
      });
      const second = await useCase.execute({
        commandId: "cmd-entrada-recebimento-002",
        movementCode: "EST-CMD-0002",
        receivingEntryItemId: seed.receivingEntryItemIds[1],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Entrada complementar de monitores",
        regularizedByUserId: seed.userId
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.ok && first.ok ? second.stockPositionId : null).toBe(
        first.ok ? first.stockPositionId : null
      );
      await expectStockPosition(client, {
        physicalQuantity: 5,
        availableQuantity: 5,
        version: 2
      });
      await expectCounts(client, {
        regularizations: 2,
        movements: 2,
        audits: 2,
        idempotencyRows: 2
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("returns the stored result for retries with the same command id", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedReceivingStock(client, [4]);
      const useCase = new RegularizeReceivingStock(new PostgresReceivingStockRegularizer(pool));
      const command = {
        commandId: "cmd-entrada-idempotente-001",
        movementCode: "EST-IDEM-0001",
        receivingEntryItemId: seed.receivingEntryItemIds[0],
        originType: "PENDENTE" as const,
        regularizedAt: new Date("2026-09-23T19:00:00.000Z"),
        summary: "Entrada idempotente de monitores",
        regularizedByUserId: seed.userId
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first.ok).toBe(true);
      expect(retry).toEqual(first);
      await expectStockPosition(client, {
        physicalQuantity: 4,
        availableQuantity: 4,
        version: 1
      });
      await expectCounts(client, {
        regularizations: 1,
        movements: 1,
        audits: 1,
        idempotencyRows: 1
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects the same command id with a different payload", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedReceivingStock(client, [2, 1]);
      const useCase = new RegularizeReceivingStock(new PostgresReceivingStockRegularizer(pool));
      const regularizedAt = new Date("2026-09-23T19:00:00.000Z");

      const first = await useCase.execute({
        commandId: "cmd-entrada-conflito-001",
        movementCode: "EST-CONF-0001",
        receivingEntryItemId: seed.receivingEntryItemIds[0],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Entrada inicial",
        regularizedByUserId: seed.userId
      });
      const conflict = await useCase.execute({
        commandId: "cmd-entrada-conflito-001",
        movementCode: "EST-CONF-0002",
        receivingEntryItemId: seed.receivingEntryItemIds[1],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Entrada divergente",
        regularizedByUserId: seed.userId
      });

      expect(first.ok).toBe(true);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectStockPosition(client, {
        physicalQuantity: 2,
        availableQuantity: 2,
        version: 1
      });
      await expectCounts(client, {
        regularizations: 1,
        movements: 1,
        audits: 1,
        idempotencyRows: 1
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects duplicate regularization or duplicate movement code without changing balances", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedReceivingStock(client, [3, 2]);
      const useCase = new RegularizeReceivingStock(new PostgresReceivingStockRegularizer(pool));
      const regularizedAt = new Date("2026-09-23T19:00:00.000Z");

      const first = await useCase.execute({
        commandId: "cmd-entrada-duplicada-001",
        movementCode: "EST-DUP-0001",
        receivingEntryItemId: seed.receivingEntryItemIds[0],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Entrada inicial",
        regularizedByUserId: seed.userId
      });
      const duplicateRegularization = await useCase.execute({
        commandId: "cmd-entrada-duplicada-002",
        movementCode: "EST-DUP-0002",
        receivingEntryItemId: seed.receivingEntryItemIds[0],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Regularizacao duplicada",
        regularizedByUserId: seed.userId
      });
      const duplicateMovementCode = await useCase.execute({
        commandId: "cmd-entrada-duplicada-003",
        movementCode: "EST-DUP-0001",
        receivingEntryItemId: seed.receivingEntryItemIds[1],
        originType: "PENDENTE",
        regularizedAt,
        summary: "Codigo de movimento duplicado",
        regularizedByUserId: seed.userId
      });

      expect(first.ok).toBe(true);
      expect(duplicateRegularization).toEqual({ ok: false, reason: "DUPLICATE_REGULARIZATION" });
      expect(duplicateMovementCode).toEqual({ ok: false, reason: "DUPLICATE_MOVEMENT_CODE" });
      await expectStockPosition(client, {
        physicalQuantity: 3,
        availableQuantity: 3,
        version: 1
      });
      await expectCounts(client, {
        regularizations: 1,
        movements: 1,
        audits: 1,
        idempotencyRows: 1
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects unknown receiving items without side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const useCase = new RegularizeReceivingStock(new PostgresReceivingStockRegularizer(pool));
      const receivingEntryItemId = randomUUID();
      const result = await useCase.execute({
        commandId: "cmd-entrada-inexistente-001",
        movementCode: "EST-INEX-0001",
        receivingEntryItemId,
        originType: "PENDENTE",
        regularizedAt: new Date("2026-09-23T19:00:00.000Z"),
        summary: "Entrada de item inexistente"
      });

      expect(result).toEqual({
        ok: false,
        reason: "RECEIVING_ENTRY_ITEM_NOT_FOUND",
        receivingEntryItemId
      });
      await expectCounts(client, {
        regularizations: 0,
        movements: 0,
        audits: 0,
        idempotencyRows: 1
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectStockPosition(
  client: Client,
  expected: { physicalQuantity: number; availableQuantity: number; version: number }
): Promise<void> {
  const position = await client.query<{
    physical_quantity: number;
    reserved_quantity: number;
    separating_quantity: number;
    available_quantity: number;
    version: number;
  }>(
    `select "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "version"
       from "stock_position"`
  );

  expect(position.rows).toEqual([
    {
      physical_quantity: expected.physicalQuantity,
      reserved_quantity: 0,
      separating_quantity: 0,
      available_quantity: expected.availableQuantity,
      version: expected.version
    }
  ]);
}

async function expectCounts(
  client: Client,
  expected: { regularizations: number; movements: number; audits: number; idempotencyRows: number }
): Promise<void> {
  const counts = await client.query<{
    regularizations: number;
    movements: number;
    stock_positions: number;
    audits: number;
    idempotency_rows: number;
  }>(
    `select
       (select count(*)::int from "receiving_entry_item_regularization") as regularizations,
       (select count(*)::int from "stock_movement") as movements,
       (select count(*)::int from "stock_position") as stock_positions,
       (select count(*)::int from "audit_entry") as audits,
       (select count(*)::int from "command_idempotency" where "command_name" = 'stock.regularize_receiving_stock') as idempotency_rows`
  );

  expect(counts.rows).toEqual([
    {
      regularizations: expected.regularizations,
      movements: expected.movements,
      stock_positions: expected.regularizations === 0 ? 0 : 1,
      audits: expected.audits,
      idempotency_rows: expected.idempotencyRows
    }
  ]);
}

async function seedReceivingStock(
  client: Client,
  quantities: number[]
): Promise<{ receivingEntryItemIds: string[]; userId: string }> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const receivingEntryId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-${receivingEntryId.slice(0, 8).toUpperCase()}`, "GRE Entrada Estoque"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, `ENT-${receivingEntryId.slice(0, 8).toUpperCase()}`, "Almoxarifado Entrada", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CL-${receivingEntryId.slice(0, 8).toUpperCase()}`, "Informatica Entrada"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [
      materialSingularId,
      `MAT-${receivingEntryId.slice(0, 8).toUpperCase()}`,
      "Monitor Entrada",
      materialClassId,
      "EQUIPAMENTO"
    ]
  );
  await client.query(
    `insert into "receiving_entry" (
      "id", "code", "receiving_entity_id", "received_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [
      receivingEntryId,
      `REC-${receivingEntryId.slice(0, 8).toUpperCase()}`,
      entityId,
      "2026-09-23T18:00:00.000Z"
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Entrada Estoque"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [userId, personId, `entrada-${userId}@gmap.local`]
  );

  const receivingEntryItemIds: string[] = [];

  for (const [index, quantity] of quantities.entries()) {
    const receivingEntryItemId = randomUUID();
    await client.query(
      `insert into "receiving_entry_item" (
        "id", "receiving_entry_id", "line_number", "material_singular_id", "origin_type", "quantity", "updated_at"
      ) values ($1, $2, $3, $4, 'PENDENTE', $5, current_timestamp)`,
      [receivingEntryItemId, receivingEntryId, index + 1, materialSingularId, quantity]
    );
    receivingEntryItemIds.push(receivingEntryItemId);
  }

  return { receivingEntryItemIds, userId };
}
