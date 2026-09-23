import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PrepareSupplyOrderCancellation } from "../../src/modules/contracts/application/prepare-supply-order-cancellation";
import { PostgresSupplyOrderCancellationPreparer } from "../../src/modules/contracts/infrastructure/postgres-supply-order-cancellation-preparer";

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

describe("prepare supply order cancellation", () => {
  it("rejects blank command id or reason before persistence", async () => {
    const useCase = new PrepareSupplyOrderCancellation({
      prepare: async () => {
        throw new Error("preparer should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        supplyOrderId: randomUUID(),
        reason: "Material nao sera entregue"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-cancelamento-001",
        supplyOrderId: randomUUID(),
        reason: "  "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REASON" });
  });

  it("prepares a cancellation request without changing supply order status", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { supplyOrderId } = await seedSupplyOrder(client);
      const useCase = new PrepareSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationPreparer(pool)
      );
      const preparedAt = new Date("2026-09-22T11:00:00.000Z");

      const result = await useCase.execute({
        commandId: "cmd-prepara-cancelamento-001",
        supplyOrderId,
        reason: "Material nao sera mais fornecido",
        preparedAt
      });

      expect(result.ok).toBe(true);
      await expectPreparedCancellation(client, supplyOrderId, {
        cancellationCount: 1,
        reason: "Material nao sera mais fornecido",
        supplyOrderStatus: "EMITIDA"
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("returns the stored result for retries with the same idempotency key", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { supplyOrderId } = await seedSupplyOrder(client);
      const useCase = new PrepareSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationPreparer(pool)
      );
      const command = {
        commandId: "cmd-prepara-cancelamento-idem-001",
        supplyOrderId,
        reason: "Material nao sera mais fornecido",
        preparedAt: new Date("2026-09-22T11:00:00.000Z")
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first.ok).toBe(true);
      expect(retry).toEqual(first);
      await expectPreparedCancellation(client, supplyOrderId, {
        cancellationCount: 1,
        reason: "Material nao sera mais fornecido",
        supplyOrderStatus: "EMITIDA"
      });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializes concurrent retries with the same idempotency key", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { supplyOrderId } = await seedSupplyOrder(client);
      const useCase = new PrepareSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationPreparer(pool)
      );
      const command = {
        commandId: "cmd-prepara-cancelamento-concorrente-001",
        supplyOrderId,
        reason: "Material nao sera mais fornecido",
        preparedAt: new Date("2026-09-22T11:00:00.000Z")
      };

      const results = await Promise.all([useCase.execute(command), useCase.execute(command)]);

      expect(results[0].ok).toBe(true);
      expect(results[1]).toEqual(results[0]);
      await expectPreparedCancellation(client, supplyOrderId, {
        cancellationCount: 1,
        reason: "Material nao sera mais fornecido",
        supplyOrderStatus: "EMITIDA"
      });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects the same idempotency key with a different command payload", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { supplyOrderId } = await seedSupplyOrder(client);
      const useCase = new PrepareSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationPreparer(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-prepara-cancelamento-conflito-001",
        supplyOrderId,
        reason: "Material nao sera mais fornecido",
        preparedAt: new Date("2026-09-22T11:00:00.000Z")
      });
      const conflict = await useCase.execute({
        commandId: "cmd-prepara-cancelamento-conflito-001",
        supplyOrderId,
        reason: "Motivo diferente",
        preparedAt: new Date("2026-09-22T11:00:00.000Z")
      });

      expect(first.ok).toBe(true);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectPreparedCancellation(client, supplyOrderId, {
        cancellationCount: 1,
        reason: "Material nao sera mais fornecido",
        supplyOrderStatus: "EMITIDA"
      });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects another cancellation request for the same supply order", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { supplyOrderId } = await seedSupplyOrder(client);
      const useCase = new PrepareSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationPreparer(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-prepara-cancelamento-duplicidade-001",
        supplyOrderId,
        reason: "Material nao sera mais fornecido",
        preparedAt: new Date("2026-09-22T11:00:00.000Z")
      });
      const duplicated = await useCase.execute({
        commandId: "cmd-prepara-cancelamento-duplicidade-002",
        supplyOrderId,
        reason: "Outra tentativa",
        preparedAt: new Date("2026-09-22T11:05:00.000Z")
      });

      expect(first.ok).toBe(true);
      expect(duplicated).toEqual({ ok: false, reason: "CANCELLATION_ALREADY_EXISTS" });
      await expectPreparedCancellation(client, supplyOrderId, {
        cancellationCount: 1,
        reason: "Material nao sera mais fornecido",
        supplyOrderStatus: "EMITIDA"
      });
      await expectIdempotencyRows(client, 2);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects cancellation preparation for an unknown supply order", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const useCase = new PrepareSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationPreparer(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-prepara-cancelamento-inexistente-001",
        supplyOrderId: randomUUID(),
        reason: "Material nao sera mais fornecido",
        preparedAt: new Date("2026-09-22T11:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "SUPPLY_ORDER_NOT_FOUND" });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectPreparedCancellation(
  client: Client,
  supplyOrderId: string,
  expected: {
    cancellationCount: number;
    reason: string;
    supplyOrderStatus: "EMITIDA" | "CANCELADA";
  }
): Promise<void> {
  const cancellations = await client.query<{
    status: string;
    reason: string;
    count: number;
  }>(
    `select min("status"::text) as status,
            min("reason") as reason,
            count(*)::int as count
       from "supply_order_cancellation"
      where "supply_order_id" = $1`,
    [supplyOrderId]
  );
  const supplyOrder = await client.query<{ status: "EMITIDA" | "CANCELADA" }>(
    `select "status" from "supply_order" where "id" = $1`,
    [supplyOrderId]
  );

  expect(cancellations.rows).toEqual([
    {
      count: expected.cancellationCount,
      reason: expected.reason,
      status: "PREPARADA"
    }
  ]);
  expect(supplyOrder.rows).toEqual([{ status: expected.supplyOrderStatus }]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'contracts.prepare_supply_order_cancellation'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function seedSupplyOrder(client: Client): Promise<{ supplyOrderId: string }> {
  const supplierId = randomUUID();
  const contractId = randomUUID();
  const supplyOrderId = randomUUID();

  await client.query(
    `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
     values ($1, $2, $3, $4, current_timestamp)`,
    [
      supplierId,
      `FORN-${supplyOrderId.slice(0, 8).toUpperCase()}`,
      "Fornecedor de Tecnologia Ltda",
      null
    ]
  );
  await client.query(
    `insert into "contract" (
      "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      contractId,
      `CTR-${supplyOrderId.slice(0, 8).toUpperCase()}`,
      supplierId,
      "Aquisicao de equipamentos",
      "2026-01-01",
      "2026-12-31"
    ]
  );
  await client.query(
    `insert into "supply_order" (
      "id", "code", "contract_id", "issued_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [
      supplyOrderId,
      `OF-${supplyOrderId.slice(0, 8).toUpperCase()}`,
      contractId,
      "2026-09-22T10:00:00.000Z"
    ]
  );

  return { supplyOrderId };
}
