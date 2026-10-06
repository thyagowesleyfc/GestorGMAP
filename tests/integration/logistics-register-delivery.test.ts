import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterLogisticsDelivery } from "../../src/modules/logistics/application/register-logistics-delivery";
import { PostgresLogisticsDeliveryRegistrar } from "../../src/modules/logistics/infrastructure/postgres-logistics-delivery-registrar";

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

describe("register logistics delivery", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new RegisterLogisticsDelivery({
      register: async () => {
        throw new Error("registrar should not be called for invalid input");
      }
    });
    const shipmentId = randomUUID();

    await expect(
      useCase.execute({
        commandId: "  ",
        code: "ENT-CMD-2026-0001",
        shipmentId,
        acceptanceStatus: "TOTAL",
        summary: "Entrega aceita"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-ent-invalid-code",
        code: "ent-cmd-2026-0001",
        shipmentId,
        acceptanceStatus: "TOTAL",
        summary: "Entrega aceita"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_DELIVERY_CODE" });

    await expect(
      useCase.execute({
        commandId: "cmd-ent-invalid-status",
        code: "ENT-CMD-2026-0002",
        shipmentId,
        acceptanceStatus: "PENDENTE" as "TOTAL",
        summary: "Entrega com status invalido"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_ACCEPTANCE_STATUS" });

    await expect(
      useCase.execute({
        commandId: "cmd-ent-invalid-summary",
        code: "ENT-CMD-2026-0003",
        shipmentId,
        acceptanceStatus: "TOTAL",
        summary: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_SUMMARY" });
  });

  it("registers a delivery acceptance idempotently without document, outbox or patrimony effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDeliveryDependencies(client);
      const useCase = new RegisterLogisticsDelivery(new PostgresLogisticsDeliveryRegistrar(pool));
      const command = {
        commandId: "cmd-entrega-registra-001",
        code: "ENT-CMD-2026-0001",
        shipmentId: seed.totalShipmentId,
        acceptanceStatus: "TOTAL" as const,
        deliveredAt: new Date("2026-09-25T13:00:00.000Z"),
        summary: "Entrega aceita integralmente pela escola",
        correlationId: "corr-entrega-registra-001"
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toMatchObject({
        ok: true,
        shipmentId: seed.totalShipmentId,
        acceptanceStatus: "TOTAL"
      });
      expect(retry).toEqual(first);
      await expectDelivery(client, {
        shipmentId: seed.totalShipmentId,
        expectedDeliveries: 1,
        acceptanceStatus: "TOTAL"
      });
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
      await expectNoDeferredSideEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects conflicts, duplicate codes, missing shipments and duplicate deliveries", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDeliveryDependencies(client);
      const useCase = new RegisterLogisticsDelivery(new PostgresLogisticsDeliveryRegistrar(pool));

      const first = await useCase.execute({
        commandId: "cmd-entrega-conflito-001",
        code: "ENT-CMD-2026-0100",
        shipmentId: seed.totalShipmentId,
        acceptanceStatus: "TOTAL",
        deliveredAt: new Date("2026-09-25T14:00:00.000Z"),
        summary: "Entrega aceita"
      });
      const conflict = await useCase.execute({
        commandId: "cmd-entrega-conflito-001",
        code: "ENT-CMD-2026-0101",
        shipmentId: seed.partialShipmentId,
        acceptanceStatus: "PARCIAL",
        deliveredAt: new Date("2026-09-25T14:00:00.000Z"),
        summary: "Payload divergente"
      });
      const duplicateCode = await useCase.execute({
        commandId: "cmd-entrega-codigo-duplicado-001",
        code: "ENT-CMD-2026-0100",
        shipmentId: seed.partialShipmentId,
        acceptanceStatus: "PARCIAL",
        deliveredAt: new Date("2026-09-25T14:10:00.000Z"),
        summary: "Codigo ja usado"
      });
      const missingShipment = await useCase.execute({
        commandId: "cmd-entrega-envio-ausente-001",
        code: "ENT-CMD-2026-0102",
        shipmentId: randomUUID(),
        acceptanceStatus: "RECUSADO",
        deliveredAt: new Date("2026-09-25T14:20:00.000Z"),
        summary: "Envio inexistente"
      });
      const duplicateDelivery = await useCase.execute({
        commandId: "cmd-entrega-duplicada-001",
        code: "ENT-CMD-2026-0103",
        shipmentId: seed.totalShipmentId,
        acceptanceStatus: "TOTAL",
        deliveredAt: new Date("2026-09-25T14:30:00.000Z"),
        summary: "Entrega ja registrada"
      });

      expect(first).toMatchObject({ ok: true, acceptanceStatus: "TOTAL" });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(duplicateCode).toEqual({ ok: false, reason: "DUPLICATE_DELIVERY_CODE" });
      expect(missingShipment).toMatchObject({ ok: false, reason: "SHIPMENT_NOT_FOUND" });
      expect(duplicateDelivery).toEqual({
        ok: false,
        reason: "DELIVERY_ALREADY_REGISTERED",
        shipmentId: seed.totalShipmentId
      });
      await expectDelivery(client, {
        shipmentId: seed.totalShipmentId,
        expectedDeliveries: 1,
        acceptanceStatus: "TOTAL"
      });
      await expectTotalDeliveries(client, 1);
      await expectAuditEntries(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializes concurrent delivery registrations for the same shipment", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDeliveryDependencies(client);
      const useCase = new RegisterLogisticsDelivery(new PostgresLogisticsDeliveryRegistrar(pool));
      const common = {
        shipmentId: seed.refusedShipmentId,
        acceptanceStatus: "RECUSADO" as const,
        deliveredAt: new Date("2026-09-25T15:00:00.000Z"),
        summary: "Entrega concorrente recusada"
      };

      const results = await Promise.all([
        useCase.execute({
          ...common,
          commandId: "cmd-entrega-concorrente-001",
          code: "ENT-CMD-2026-0200"
        }),
        useCase.execute({
          ...common,
          commandId: "cmd-entrega-concorrente-002",
          code: "ENT-CMD-2026-0201"
        })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "DELIVERY_ALREADY_REGISTERED",
          shipmentId: seed.refusedShipmentId
        }
      ]);
      await expectTotalDeliveries(client, 1);
      await expectAuditEntries(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectDelivery(
  client: Client,
  input: {
    shipmentId: string;
    expectedDeliveries: number;
    acceptanceStatus: "TOTAL" | "PARCIAL" | "RECUSADO";
  }
): Promise<void> {
  const delivery = await client.query<{
    count: number;
    acceptance_status: string | null;
  }>(
    `select count(*)::int as count,
            min("acceptance_status"::text) as acceptance_status
       from "logistics_delivery"
      where "shipment_id" = $1`,
    [input.shipmentId]
  );

  expect(delivery.rows).toEqual([
    {
      count: input.expectedDeliveries,
      acceptance_status: input.expectedDeliveries === 0 ? null : input.acceptanceStatus
    }
  ]);
}

async function expectTotalDeliveries(client: Client, expectedCount: number): Promise<void> {
  const deliveries = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_delivery"`
  );

  expect(deliveries.rows).toEqual([{ count: expectedCount }]);
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
      action: expectedCount === 0 ? null : "logistics.register_delivery",
      object_type: expectedCount === 0 ? null : "logistics_delivery"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'logistics.register_delivery'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectNoDeferredSideEffects(client: Client): Promise<void> {
  const absentTables = await client.query<{ count: number }>(
    `select count(*)::int as count
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('logistics_delivery_document', 'logistics_recollection', 'outbox_event')`
  );

  expect(absentTables.rows).toEqual([{ count: 0 }]);
}

type DeliverySeed = {
  totalShipmentId: string;
  partialShipmentId: string;
  refusedShipmentId: string;
};

async function seedDeliveryDependencies(client: Client): Promise<DeliverySeed> {
  const greId = randomUUID();
  const receivingEntityId = randomUUID();
  const materialRequestId = randomUUID();
  const totalShipmentId = randomUUID();
  const partialShipmentId = randomUUID();
  const refusedShipmentId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-ENT-CMD", "GRE Entrega Command"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, "ENT-ENT-CMD", "Escola Entrega Command", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, 3, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-ENT-CMD-0001",
      receivingEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao despachada para command de entrega"
    ]
  );
  await insertShipment(client, {
    shipmentId: totalShipmentId,
    code: "EXP-ENT-CMD-2026-0001",
    materialRequestId,
    receivingEntityId
  });
  await insertShipment(client, {
    shipmentId: partialShipmentId,
    code: "EXP-ENT-CMD-2026-0002",
    materialRequestId,
    receivingEntityId
  });
  await insertShipment(client, {
    shipmentId: refusedShipmentId,
    code: "EXP-ENT-CMD-2026-0003",
    materialRequestId,
    receivingEntityId
  });

  return { totalShipmentId, partialShipmentId, refusedShipmentId };
}

async function insertShipment(
  client: Client,
  input: {
    shipmentId: string;
    code: string;
    materialRequestId: string;
    receivingEntityId: string;
  }
): Promise<void> {
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      input.shipmentId,
      input.code,
      input.materialRequestId,
      input.receivingEntityId,
      "2026-09-24T20:00:00.000Z",
      "Envio para command de entrega"
    ]
  );
}
