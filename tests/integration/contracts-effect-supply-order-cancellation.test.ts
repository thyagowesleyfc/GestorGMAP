import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { EffectSupplyOrderCancellation } from "../../src/modules/contracts/application/effect-supply-order-cancellation";
import { PostgresSupplyOrderCancellationEffecter } from "../../src/modules/contracts/infrastructure/postgres-supply-order-cancellation-effecter";

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

describe("effect supply order cancellation", () => {
  it("rejects blank command id before persistence", async () => {
    const useCase = new EffectSupplyOrderCancellation({
      effect: async () => {
        throw new Error("effecter should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        cancellationId: randomUUID()
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });
  });

  it("effects an authorized cancellation and restores committed contract balance", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedAuthorizedCancellation(client);
      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-efetiva-cancelamento-001",
        cancellationId: seed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      });

      expect(result).toEqual({
        ok: true,
        cancellationId: seed.cancellationId,
        supplyOrderId: seed.supplyOrderId,
        status: "EFETIVADA"
      });
      await expectCancellationEffect(client, seed);
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

      const seed = await seedAuthorizedCancellation(client);
      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );
      const command = {
        commandId: "cmd-efetiva-cancelamento-idem-001",
        cancellationId: seed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({
        ok: true,
        cancellationId: seed.cancellationId,
        supplyOrderId: seed.supplyOrderId,
        status: "EFETIVADA"
      });
      expect(retry).toEqual(first);
      await expectCancellationEffect(client, seed);
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

      const seed = await seedAuthorizedCancellation(client);
      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );
      const command = {
        commandId: "cmd-efetiva-cancelamento-concorrente-001",
        cancellationId: seed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      };

      const results = await Promise.all([useCase.execute(command), useCase.execute(command)]);

      expect(results[0]).toEqual({
        ok: true,
        cancellationId: seed.cancellationId,
        supplyOrderId: seed.supplyOrderId,
        status: "EFETIVADA"
      });
      expect(results[1]).toEqual(results[0]);
      await expectCancellationEffect(client, seed);
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

      const seed = await seedAuthorizedCancellation(client);
      const otherSeed = await seedAuthorizedCancellation(client);
      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-efetiva-cancelamento-conflito-001",
        cancellationId: seed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      });
      const conflict = await useCase.execute({
        commandId: "cmd-efetiva-cancelamento-conflito-001",
        cancellationId: otherSeed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      });

      expect(first).toEqual({
        ok: true,
        cancellationId: seed.cancellationId,
        supplyOrderId: seed.supplyOrderId,
        status: "EFETIVADA"
      });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectCancellationEffect(client, seed);
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects an unknown cancellation", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-efetiva-cancelamento-inexistente-001",
        cancellationId: randomUUID(),
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "CANCELLATION_NOT_FOUND" });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects a cancellation that is not authorized", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedAuthorizedCancellation(client, { cancellationStatus: "PREPARADA" });
      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-efetiva-cancelamento-nao-autorizado-001",
        cancellationId: seed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "CANCELLATION_NOT_AUTHORIZED" });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects a cancellation whose supply order is already cancelled", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedAuthorizedCancellation(client, { supplyOrderStatus: "CANCELADA" });
      const useCase = new EffectSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationEffecter(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-efetiva-cancelamento-of-cancelada-001",
        cancellationId: seed.cancellationId,
        effectiveAt: new Date("2026-09-22T20:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "SUPPLY_ORDER_ALREADY_CANCELLED" });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type SeedOptions = {
  cancellationStatus?: "PREPARADA" | "AUTORIZADA";
  supplyOrderStatus?: "EMITIDA" | "CANCELADA";
};

type CancellationSeed = {
  cancellationId: string;
  supplyOrderId: string;
  contractItemId: string;
};

async function expectCancellationEffect(client: Client, seed: CancellationSeed): Promise<void> {
  const cancellation = await client.query<{ status: string; effective_at: string }>(
    `select "status"::text, "effective_at"::text
       from "supply_order_cancellation"
      where "id" = $1`,
    [seed.cancellationId]
  );
  const supplyOrder = await client.query<{ status: string; version: number }>(
    `select "status"::text, "version"
       from "supply_order"
      where "id" = $1`,
    [seed.supplyOrderId]
  );
  const position = await client.query<{
    committed_quantity: number;
    available_quantity: number;
    committed_amount: string;
    available_amount: string;
    version: number;
  }>(
    `select "committed_quantity",
            "available_quantity",
            "committed_amount"::text,
            "available_amount"::text,
            "version"
       from "contract_balance_position"
      where "contract_item_id" = $1`,
    [seed.contractItemId]
  );
  const movements = await client.query<{
    count: number;
    quantity_delta: number;
    amount_delta: string;
  }>(
    `select count(*)::int as count,
            coalesce(sum("quantity_delta"), 0)::int as quantity_delta,
            coalesce(sum("amount_delta"), 0)::text as amount_delta
       from "contract_balance_movement"
      where "type" = 'CANCELAMENTO_OF'
        and "contract_item_id" = $1`,
    [seed.contractItemId]
  );

  expect(cancellation.rows).toEqual([
    {
      status: "EFETIVADA",
      effective_at: "2026-09-22 17:00:00"
    }
  ]);
  expect(supplyOrder.rows).toEqual([{ status: "CANCELADA", version: 2 }]);
  expect(position.rows).toEqual([
    {
      committed_quantity: 0,
      available_quantity: 10,
      committed_amount: "0.00",
      available_amount: "12505.00",
      version: 2
    }
  ]);
  expect(movements.rows).toEqual([
    {
      count: 1,
      quantity_delta: 10,
      amount_delta: "12505.00"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'contracts.effect_supply_order_cancellation'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function seedAuthorizedCancellation(
  client: Client,
  options: SeedOptions = {}
): Promise<CancellationSeed> {
  const cancellationStatus = options.cancellationStatus ?? "AUTORIZADA";
  const supplyOrderStatus = options.supplyOrderStatus ?? "EMITIDA";
  const supplierId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const contractId = randomUUID();
  const contractItemId = randomUUID();
  const supplyOrderId = randomUUID();
  const cancellationId = randomUUID();
  const codeSuffix = supplyOrderId.slice(0, 8).toUpperCase();

  await client.query(
    `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
     values ($1, $2, $3, $4, current_timestamp)`,
    [supplierId, `FORN-${codeSuffix}`, "Fornecedor de Tecnologia Ltda", null]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLASSE-${codeSuffix}`, "Informatica"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, `MAT-${codeSuffix}`, "Monitor", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "contract" (
      "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      contractId,
      `CTR-${codeSuffix}`,
      supplierId,
      "Aquisicao de equipamentos",
      "2026-01-01",
      "2026-12-31"
    ]
  );
  await client.query(
    `insert into "contract_item" (
      "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [contractItemId, `CTR-${codeSuffix}-ITEM-001`, contractId, 1, materialSingularId, 10, "1250.50"]
  );
  await client.query(
    `insert into "contract_balance_position" (
      "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
      "total_amount", "committed_amount", "available_amount", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [randomUUID(), contractItemId, 10, 10, 0, "12505.00", "12505.00", "0.00"]
  );
  await client.query(
    `insert into "supply_order" (
      "id", "code", "contract_id", "status", "issued_at", "updated_at"
    ) values ($1, $2, $3, $4, $5, current_timestamp)`,
    [supplyOrderId, `OF-${codeSuffix}`, contractId, supplyOrderStatus, "2026-09-22T10:00:00.000Z"]
  );
  await client.query(
    `insert into "supply_order_item" (
      "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [randomUUID(), supplyOrderId, contractId, contractItemId, 1, 10, "1250.50", "12505.00"]
  );

  if (cancellationStatus === "AUTORIZADA") {
    await client.query(
      `insert into "supply_order_cancellation" (
        "id", "supply_order_id", "status", "reason", "prepared_at", "authorized_at", "updated_at"
      ) values ($1, $2, 'AUTORIZADA', $3, $4, $5, current_timestamp)`,
      [
        cancellationId,
        supplyOrderId,
        "Material nao sera mais fornecido",
        "2026-09-22T11:00:00.000Z",
        "2026-09-22T15:00:00.000Z"
      ]
    );
  } else {
    await client.query(
      `insert into "supply_order_cancellation" (
        "id", "supply_order_id", "reason", "prepared_at", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)`,
      [
        cancellationId,
        supplyOrderId,
        "Material nao sera mais fornecido",
        "2026-09-22T11:00:00.000Z"
      ]
    );
  }

  return { cancellationId, supplyOrderId, contractItemId };
}
