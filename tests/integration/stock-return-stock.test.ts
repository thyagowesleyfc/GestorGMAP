import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { ReturnStock } from "../../src/modules/stock/application/return-stock";
import { PostgresStockReturner } from "../../src/modules/stock/infrastructure/postgres-stock-returner";

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

describe("return stock", () => {
  it("uses pessimistic locks so concurrent returns cannot exceed separating stock", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { stockPositionId, stockSeparationId } = await seedSeparatedStock(client);
      const useCase = new ReturnStock(new PostgresStockReturner(pool));
      const returnedAt = new Date("2026-09-23T18:00:00.000Z");

      const results = await Promise.all([
        useCase.execute({
          commandId: "cmd-devolucao-estoque-001",
          code: "RET-LOCK-0001",
          stockPositionId,
          stockSeparationId,
          quantity: 10,
          returnedAt,
          summary: "Devolucao concorrente de monitores"
        }),
        useCase.execute({
          commandId: "cmd-devolucao-estoque-002",
          code: "RET-LOCK-0002",
          stockPositionId,
          stockSeparationId,
          quantity: 10,
          returnedAt,
          summary: "Devolucao concorrente de monitores"
        })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "INSUFFICIENT_SEPARATING_STOCK",
          stockPositionId,
          stockSeparationId
        }
      ]);

      await expectStockReturnedOnce(client, stockPositionId);
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

      const { stockPositionId, stockSeparationId } = await seedSeparatedStock(client);
      const useCase = new ReturnStock(new PostgresStockReturner(pool));
      const command = {
        commandId: "cmd-devolucao-idempotente-001",
        code: "RET-IDEM-0001",
        stockPositionId,
        stockSeparationId,
        quantity: 10,
        returnedAt: new Date("2026-09-23T18:00:00.000Z"),
        summary: "Devolucao idempotente de monitores"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first.ok).toBe(true);
      expect(retry).toEqual(first);
      await expectStockReturnedOnce(client, stockPositionId);
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

      const { stockPositionId, stockSeparationId } = await seedSeparatedStock(client);
      const useCase = new ReturnStock(new PostgresStockReturner(pool));
      const returnedAt = new Date("2026-09-23T18:00:00.000Z");

      const first = await useCase.execute({
        commandId: "cmd-devolucao-conflito-001",
        code: "RET-CONF-0001",
        stockPositionId,
        stockSeparationId,
        quantity: 5,
        returnedAt,
        summary: "Devolucao inicial"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-devolucao-conflito-001",
        code: "RET-CONF-0002",
        stockPositionId,
        stockSeparationId,
        quantity: 1,
        returnedAt,
        summary: "Devolucao divergente"
      });

      expect(first.ok).toBe(true);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectStockPosition(client, stockPositionId, {
        reservedQuantity: 0,
        separatingQuantity: 5,
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

  it("rejects duplicate return codes without changing balances", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { stockPositionId, stockSeparationId } = await seedSeparatedStock(client);
      const useCase = new ReturnStock(new PostgresStockReturner(pool));
      const returnedAt = new Date("2026-09-23T18:00:00.000Z");

      const first = await useCase.execute({
        commandId: "cmd-devolucao-duplicada-001",
        code: "RET-DUP-0001",
        stockPositionId,
        stockSeparationId,
        quantity: 5,
        returnedAt,
        summary: "Devolucao inicial"
      });
      const duplicate = await useCase.execute({
        commandId: "cmd-devolucao-duplicada-002",
        code: "RET-DUP-0001",
        stockPositionId,
        stockSeparationId,
        quantity: 1,
        returnedAt,
        summary: "Devolucao com codigo duplicado"
      });

      expect(first.ok).toBe(true);
      expect(duplicate).toEqual({ ok: false, reason: "DUPLICATE_RETURN_CODE" });
      await expectStockPosition(client, stockPositionId, {
        reservedQuantity: 0,
        separatingQuantity: 5,
        availableQuantity: 5,
        version: 2
      });
      await expectAuditEntries(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects unknown or insufficient separations without changing balances", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { stockPositionId, stockSeparationId } = await seedSeparatedStock(client);
      const useCase = new ReturnStock(new PostgresStockReturner(pool));
      const returnedAt = new Date("2026-09-23T18:00:00.000Z");
      const unknownStockSeparationId = randomUUID();

      const insufficient = await useCase.execute({
        commandId: "cmd-devolucao-indisponivel-001",
        code: "RET-INDISP-0001",
        stockPositionId,
        stockSeparationId,
        quantity: 11,
        returnedAt,
        summary: "Devolucao acima da separacao"
      });
      const missing = await useCase.execute({
        commandId: "cmd-devolucao-inexistente-001",
        code: "RET-INEX-0001",
        stockPositionId,
        stockSeparationId: unknownStockSeparationId,
        quantity: 1,
        returnedAt,
        summary: "Devolucao de separacao inexistente"
      });

      expect(insufficient).toEqual({
        ok: false,
        reason: "INSUFFICIENT_SEPARATING_STOCK",
        stockPositionId,
        stockSeparationId
      });
      expect(missing).toEqual({
        ok: false,
        reason: "STOCK_SEPARATION_NOT_FOUND",
        stockPositionId,
        stockSeparationId: unknownStockSeparationId
      });
      await expectStockPosition(client, stockPositionId, {
        reservedQuantity: 0,
        separatingQuantity: 10,
        availableQuantity: 0,
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

async function expectStockReturnedOnce(client: Client, stockPositionId: string): Promise<void> {
  const returns = await client.query<{ count: number }>(
    `select count(*)::int as count from "stock_return"`
  );

  expect(returns.rows).toEqual([{ count: 1 }]);
  await expectStockPosition(client, stockPositionId, {
    reservedQuantity: 0,
    separatingQuantity: 0,
    availableQuantity: 10,
    version: 2
  });
}

async function expectStockPosition(
  client: Client,
  stockPositionId: string,
  expected: {
    reservedQuantity: number;
    separatingQuantity: number;
    availableQuantity: number;
    version: number;
  }
): Promise<void> {
  const position = await client.query<{
    reserved_quantity: number;
    separating_quantity: number;
    available_quantity: number;
    version: number;
  }>(
    `select "reserved_quantity", "separating_quantity", "available_quantity", "version"
       from "stock_position"
      where "id" = $1`,
    [stockPositionId]
  );

  expect(position.rows).toEqual([
    {
      reserved_quantity: expected.reservedQuantity,
      separating_quantity: expected.separatingQuantity,
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
      action: "stock.return_stock",
      object_type: "stock_return"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'stock.return_stock'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function seedSeparatedStock(
  client: Client
): Promise<{ stockPositionId: string; stockSeparationId: string }> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const stockPositionId = randomUUID();
  const stockReservationId = randomUUID();
  const stockSeparationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-${stockPositionId.slice(0, 8).toUpperCase()}`, "GRE Devolucao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, `ENT-${stockPositionId.slice(0, 8).toUpperCase()}`, "Almoxarifado Devolucao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CL-${stockPositionId.slice(0, 8).toUpperCase()}`, "Informatica Devolucao"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [
      materialSingularId,
      `MAT-${stockPositionId.slice(0, 8).toUpperCase()}`,
      "Monitor Devolucao",
      materialClassId,
      "EQUIPAMENTO"
    ]
  );
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, 'PENDENTE', 10, 0, 10, 0, current_timestamp)`,
    [stockPositionId, entityId, materialSingularId]
  );
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
    ) values ($1, $2, $3, 10, $4, $5, current_timestamp)`,
    [
      stockReservationId,
      `RES-${stockPositionId.slice(0, 8).toUpperCase()}`,
      stockPositionId,
      "2026-09-23T16:00:00.000Z",
      "Reserva para devolucao"
    ]
  );
  await client.query(
    `insert into "stock_separation" (
      "id", "code", "stock_position_id", "stock_reservation_id", "quantity", "separated_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, 10, $5, $6, current_timestamp)`,
    [
      stockSeparationId,
      `SEP-${stockPositionId.slice(0, 8).toUpperCase()}`,
      stockPositionId,
      stockReservationId,
      "2026-09-23T17:00:00.000Z",
      "Separacao para devolucao"
    ]
  );

  return { stockPositionId, stockSeparationId };
}
