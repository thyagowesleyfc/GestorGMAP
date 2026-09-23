import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AuthorizeSupplyOrderCancellation } from "../../src/modules/contracts/application/authorize-supply-order-cancellation";
import { PostgresSupplyOrderCancellationAuthorizer } from "../../src/modules/contracts/infrastructure/postgres-supply-order-cancellation-authorizer";

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

describe("authorize supply order cancellation", () => {
  it("rejects blank command id before persistence", async () => {
    const useCase = new AuthorizeSupplyOrderCancellation({
      authorize: async () => {
        throw new Error("authorizer should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        cancellationId: randomUUID()
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });
  });

  it("authorizes a prepared cancellation without changing supply order status", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { cancellationId, supplyOrderId } = await seedSupplyOrderCancellation(client);
      const useCase = new AuthorizeSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationAuthorizer(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-autoriza-cancelamento-001",
        cancellationId,
        authorizedAt: new Date("2026-09-22T15:00:00.000Z")
      });

      expect(result).toEqual({ ok: true, cancellationId, status: "AUTORIZADA" });
      await expectAuthorizedCancellation(client, cancellationId, supplyOrderId);
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

      const { cancellationId, supplyOrderId } = await seedSupplyOrderCancellation(client);
      const useCase = new AuthorizeSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationAuthorizer(pool)
      );
      const command = {
        commandId: "cmd-autoriza-cancelamento-idem-001",
        cancellationId,
        authorizedAt: new Date("2026-09-22T15:00:00.000Z")
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({ ok: true, cancellationId, status: "AUTORIZADA" });
      expect(retry).toEqual(first);
      await expectAuthorizedCancellation(client, cancellationId, supplyOrderId);
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

      const { cancellationId, supplyOrderId } = await seedSupplyOrderCancellation(client);
      const useCase = new AuthorizeSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationAuthorizer(pool)
      );
      const command = {
        commandId: "cmd-autoriza-cancelamento-concorrente-001",
        cancellationId,
        authorizedAt: new Date("2026-09-22T15:00:00.000Z")
      };

      const results = await Promise.all([useCase.execute(command), useCase.execute(command)]);

      expect(results[0]).toEqual({ ok: true, cancellationId, status: "AUTORIZADA" });
      expect(results[1]).toEqual(results[0]);
      await expectAuthorizedCancellation(client, cancellationId, supplyOrderId);
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

      const { cancellationId, supplyOrderId } = await seedSupplyOrderCancellation(client);
      const { cancellationId: otherCancellationId } = await seedSupplyOrderCancellation(client);
      const useCase = new AuthorizeSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationAuthorizer(pool)
      );

      const first = await useCase.execute({
        commandId: "cmd-autoriza-cancelamento-conflito-001",
        cancellationId,
        authorizedAt: new Date("2026-09-22T15:00:00.000Z")
      });
      const conflict = await useCase.execute({
        commandId: "cmd-autoriza-cancelamento-conflito-001",
        cancellationId: otherCancellationId,
        authorizedAt: new Date("2026-09-22T15:00:00.000Z")
      });

      expect(first).toEqual({ ok: true, cancellationId, status: "AUTORIZADA" });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectAuthorizedCancellation(client, cancellationId, supplyOrderId);
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

      const useCase = new AuthorizeSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationAuthorizer(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-autoriza-cancelamento-inexistente-001",
        cancellationId: randomUUID(),
        authorizedAt: new Date("2026-09-22T15:00:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "CANCELLATION_NOT_FOUND" });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects a cancellation that is not prepared", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { cancellationId } = await seedSupplyOrderCancellation(client, "AUTORIZADA");
      const useCase = new AuthorizeSupplyOrderCancellation(
        new PostgresSupplyOrderCancellationAuthorizer(pool)
      );

      const result = await useCase.execute({
        commandId: "cmd-autoriza-cancelamento-nao-preparado-001",
        cancellationId,
        authorizedAt: new Date("2026-09-22T15:30:00.000Z")
      });

      expect(result).toEqual({ ok: false, reason: "CANCELLATION_NOT_PREPARED" });
      await expectIdempotencyRows(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectAuthorizedCancellation(
  client: Client,
  cancellationId: string,
  supplyOrderId: string
): Promise<void> {
  const cancellation = await client.query<{
    status: string;
    authorized_at: string;
  }>(
    `select "status"::text,
            "authorized_at"::text
       from "supply_order_cancellation"
      where "id" = $1`,
    [cancellationId]
  );
  const supplyOrder = await client.query<{ status: string }>(
    `select "status"::text from "supply_order" where "id" = $1`,
    [supplyOrderId]
  );

  expect(cancellation.rows).toEqual([
    {
      status: "AUTORIZADA",
      authorized_at: "2026-09-22 12:00:00"
    }
  ]);
  expect(supplyOrder.rows).toEqual([{ status: "EMITIDA" }]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'contracts.authorize_supply_order_cancellation'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function seedSupplyOrderCancellation(
  client: Client,
  status: "PREPARADA" | "AUTORIZADA" = "PREPARADA"
): Promise<{ cancellationId: string; supplyOrderId: string }> {
  const supplierId = randomUUID();
  const contractId = randomUUID();
  const supplyOrderId = randomUUID();
  const cancellationId = randomUUID();
  const codeSuffix = supplyOrderId.slice(0, 8).toUpperCase();

  await client.query(
    `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
     values ($1, $2, $3, $4, current_timestamp)`,
    [supplierId, `FORN-${codeSuffix}`, "Fornecedor de Tecnologia Ltda", null]
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
    `insert into "supply_order" (
      "id", "code", "contract_id", "issued_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [supplyOrderId, `OF-${codeSuffix}`, contractId, "2026-09-22T10:00:00.000Z"]
  );

  if (status === "AUTORIZADA") {
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

  return { cancellationId, supplyOrderId };
}
