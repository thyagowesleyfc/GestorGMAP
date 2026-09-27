import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { ReserveStock } from "../../src/modules/stock/application/reserve-stock";
import { PostgresStockReserver } from "../../src/modules/stock/infrastructure/postgres-stock-reserver";

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

describe("reserve stock", () => {
  it("uses a pessimistic lock so concurrent reservations cannot overdraw availability", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { stockPositionId } = await seedStockPosition(client);
      const useCase = new ReserveStock(new PostgresStockReserver(pool));
      const reservedAt = new Date("2026-09-23T16:00:00.000Z");

      const results = await Promise.all([
        useCase.execute({
          commandId: "cmd-reserva-estoque-001",
          code: "RES-LOCK-0001",
          stockPositionId,
          quantity: 10,
          reservedAt,
          summary: "Reserva concorrente de monitores"
        }),
        useCase.execute({
          commandId: "cmd-reserva-estoque-002",
          code: "RES-LOCK-0002",
          stockPositionId,
          quantity: 10,
          reservedAt,
          summary: "Reserva concorrente de monitores"
        })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "INSUFFICIENT_STOCK_AVAILABLE",
          stockPositionId
        }
      ]);

      await expectStockReservedOnce(client, stockPositionId);
      await expectAuditEntries(client, 1);
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

      const { stockPositionId } = await seedStockPosition(client);
      const useCase = new ReserveStock(new PostgresStockReserver(pool));
      const command = {
        commandId: "cmd-reserva-idempotente-001",
        code: "RES-IDEM-0001",
        stockPositionId,
        quantity: 10,
        reservedAt: new Date("2026-09-23T16:00:00.000Z"),
        summary: "Reserva idempotente de monitores"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first.ok).toBe(true);
      expect(retry).toEqual(first);
      await expectStockReservedOnce(client, stockPositionId);
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
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

      const { stockPositionId } = await seedStockPosition(client);
      const useCase = new ReserveStock(new PostgresStockReserver(pool));
      const reservedAt = new Date("2026-09-23T16:00:00.000Z");

      const first = await useCase.execute({
        commandId: "cmd-reserva-conflito-001",
        code: "RES-CONF-0001",
        stockPositionId,
        quantity: 5,
        reservedAt,
        summary: "Reserva inicial"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-reserva-conflito-001",
        code: "RES-CONF-0002",
        stockPositionId,
        quantity: 1,
        reservedAt,
        summary: "Reserva divergente"
      });

      expect(first.ok).toBe(true);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectStockPosition(client, stockPositionId, {
        reservedQuantity: 5,
        availableQuantity: 5,
        version: 2
      });
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects unavailable or unknown stock positions without changing balances", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { stockPositionId } = await seedStockPosition(client);
      const unknownStockPositionId = randomUUID();
      const useCase = new ReserveStock(new PostgresStockReserver(pool));
      const reservedAt = new Date("2026-09-23T16:00:00.000Z");

      const insufficient = await useCase.execute({
        commandId: "cmd-reserva-indisponivel-001",
        code: "RES-INDISP-0001",
        stockPositionId,
        quantity: 11,
        reservedAt,
        summary: "Reserva acima do disponivel"
      });
      const missing = await useCase.execute({
        commandId: "cmd-reserva-inexistente-001",
        code: "RES-INEX-0001",
        stockPositionId: unknownStockPositionId,
        quantity: 1,
        reservedAt,
        summary: "Reserva de posicao inexistente"
      });

      expect(insufficient).toEqual({
        ok: false,
        reason: "INSUFFICIENT_STOCK_AVAILABLE",
        stockPositionId
      });
      expect(missing).toEqual({
        ok: false,
        reason: "STOCK_POSITION_NOT_FOUND",
        stockPositionId: unknownStockPositionId
      });
      await expectStockPosition(client, stockPositionId, {
        reservedQuantity: 0,
        availableQuantity: 10,
        version: 1
      });
      await expectAuditEntries(client, 0);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectStockReservedOnce(client: Client, stockPositionId: string): Promise<void> {
  const reservations = await client.query<{ count: number }>(
    `select count(*)::int as count from "stock_reservation"`
  );

  expect(reservations.rows).toEqual([{ count: 1 }]);
  await expectStockPosition(client, stockPositionId, {
    reservedQuantity: 10,
    availableQuantity: 0,
    version: 2
  });
}

async function expectStockPosition(
  client: Client,
  stockPositionId: string,
  expected: {
    reservedQuantity: number;
    availableQuantity: number;
    version: number;
  }
): Promise<void> {
  const position = await client.query<{
    reserved_quantity: number;
    available_quantity: number;
    version: number;
  }>(
    `select "reserved_quantity", "available_quantity", "version"
       from "stock_position"
      where "id" = $1`,
    [stockPositionId]
  );

  expect(position.rows).toEqual([
    {
      reserved_quantity: expected.reservedQuantity,
      available_quantity: expected.availableQuantity,
      version: expected.version
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

  if (expectedCount === 0) {
    expect(auditEntries.rows).toEqual([{ count: 0, action: null, object_type: null }]);
    return;
  }

  expect(auditEntries.rows).toEqual([
    {
      count: expectedCount,
      action: "stock.reserve_stock",
      object_type: "stock_reservation"
    }
  ]);
}
async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'stock.reserve_stock'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function seedStockPosition(client: Client): Promise<{ stockPositionId: string }> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const stockPositionId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-${stockPositionId.slice(0, 8).toUpperCase()}`, "GRE Reserva"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, `ENT-${stockPositionId.slice(0, 8).toUpperCase()}`, "Almoxarifado Reserva", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CL-${stockPositionId.slice(0, 8).toUpperCase()}`, "Informatica Reserva"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [
      materialSingularId,
      `MAT-${stockPositionId.slice(0, 8).toUpperCase()}`,
      "Monitor Reserva",
      materialClassId,
      "EQUIPAMENTO"
    ]
  );
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, 'PENDENTE', 10, 0, 0, 10, current_timestamp)`,
    [stockPositionId, entityId, materialSingularId]
  );

  return { stockPositionId };
}
