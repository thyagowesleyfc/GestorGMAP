import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterLogisticsShipment } from "../../src/modules/logistics/application/register-logistics-shipment";
import { PostgresLogisticsShipmentRegistrar } from "../../src/modules/logistics/infrastructure/postgres-logistics-shipment-registrar";

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

describe("register logistics shipment", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new RegisterLogisticsShipment({
      register: async () => {
        throw new Error("registrar should not be called for invalid input");
      }
    });
    const validItem = {
      stockPositionId: randomUUID(),
      stockSeparationId: randomUUID(),
      quantity: 1
    };

    await expect(
      useCase.execute({
        commandId: "  ",
        code: "EXP-INVALID-0001",
        materialRequestId: randomUUID(),
        items: [validItem],
        summary: "Expedicao valida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-exp-invalid-code",
        code: "exp-invalid-0001",
        materialRequestId: randomUUID(),
        items: [validItem],
        summary: "Expedicao valida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_SHIPMENT_CODE" });

    await expect(
      useCase.execute({
        commandId: "cmd-exp-empty-items",
        code: "EXP-INVALID-0002",
        materialRequestId: randomUUID(),
        items: [],
        summary: "Expedicao sem itens"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_ITEMS" });

    await expect(
      useCase.execute({
        commandId: "cmd-exp-invalid-qty",
        code: "EXP-INVALID-0003",
        materialRequestId: randomUUID(),
        items: [{ ...validItem, quantity: 0 }],
        summary: "Expedicao com quantidade invalida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_QUANTITY" });

    await expect(
      useCase.execute({
        commandId: "cmd-exp-dup-item",
        code: "EXP-INVALID-0004",
        materialRequestId: randomUUID(),
        items: [validItem, validItem],
        summary: "Expedicao com item duplicado"
      })
    ).resolves.toEqual({ ok: false, reason: "DUPLICATE_SHIPMENT_ITEM" });

    await expect(
      useCase.execute({
        commandId: "cmd-exp-invalid-summary",
        code: "EXP-INVALID-0005",
        materialRequestId: randomUUID(),
        items: [validItem],
        summary: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_SUMMARY" });
  });

  it("registers a dispatched request shipment idempotently without delivery side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedShipmentDependencies(client, { status: "DESPACHADA" });
      const useCase = new RegisterLogisticsShipment(new PostgresLogisticsShipmentRegistrar(pool));
      const command = {
        commandId: "cmd-expedicao-registra-001",
        code: "EXP-CMD-2026-0001",
        materialRequestId: seed.materialRequestId,
        shippedAt: new Date("2026-09-24T21:00:00.000Z"),
        summary: "Expedicao registrada para escola solicitante",
        correlationId: "corr-expedicao-registra-001",
        items: [
          {
            stockPositionId: seed.stockPositionId,
            stockSeparationId: seed.stockSeparationId,
            quantity: 2
          },
          {
            stockPositionId: seed.stockPositionId,
            stockSeparationId: seed.otherStockSeparationId,
            quantity: 1
          }
        ]
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toMatchObject({
        ok: true,
        materialRequestId: seed.materialRequestId,
        status: "REGISTRADA",
        itemCount: 2
      });
      expect(retry).toEqual(first);
      await expectShipment(client, {
        materialRequestId: seed.materialRequestId,
        receivingEntityId: seed.receivingEntityId,
        expectedShipments: 1,
        expectedItems: 2,
        expectedQuantity: 3
      });
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
      await expectNoDeliverySideEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects conflicts, invalid request states and invalid separations without partial writes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const dispatched = await seedShipmentDependencies(client, { status: "DESPACHADA" });
      const duplicateCodeSeed = await seedShipmentDependencies(client, { status: "DESPACHADA" });
      const analyzed = await seedShipmentDependencies(client, { status: "ANALISADA" });
      const useCase = new RegisterLogisticsShipment(new PostgresLogisticsShipmentRegistrar(pool));

      const first = await useCase.execute({
        commandId: "cmd-expedicao-conflito-001",
        code: "EXP-CMD-2026-0100",
        materialRequestId: dispatched.materialRequestId,
        shippedAt: new Date("2026-09-24T21:30:00.000Z"),
        summary: "Primeira expedicao registrada",
        items: [
          {
            stockPositionId: dispatched.stockPositionId,
            stockSeparationId: dispatched.stockSeparationId,
            quantity: 2
          }
        ]
      });
      const conflict = await useCase.execute({
        commandId: "cmd-expedicao-conflito-001",
        code: "EXP-CMD-2026-0101",
        materialRequestId: duplicateCodeSeed.materialRequestId,
        shippedAt: new Date("2026-09-24T21:30:00.000Z"),
        summary: "Payload divergente",
        items: [
          {
            stockPositionId: duplicateCodeSeed.stockPositionId,
            stockSeparationId: duplicateCodeSeed.stockSeparationId,
            quantity: 1
          }
        ]
      });
      const duplicateCode = await useCase.execute({
        commandId: "cmd-expedicao-codigo-duplicado-001",
        code: "EXP-CMD-2026-0100",
        materialRequestId: duplicateCodeSeed.materialRequestId,
        shippedAt: new Date("2026-09-24T21:40:00.000Z"),
        summary: "Codigo ja usado em outra expedicao",
        items: [
          {
            stockPositionId: duplicateCodeSeed.stockPositionId,
            stockSeparationId: duplicateCodeSeed.stockSeparationId,
            quantity: 1
          }
        ]
      });
      const missingRequest = await useCase.execute({
        commandId: "cmd-expedicao-solicitacao-ausente-001",
        code: "EXP-CMD-2026-0102",
        materialRequestId: randomUUID(),
        shippedAt: new Date("2026-09-24T21:40:00.000Z"),
        summary: "Solicitacao inexistente",
        items: [
          {
            stockPositionId: duplicateCodeSeed.stockPositionId,
            stockSeparationId: duplicateCodeSeed.otherStockSeparationId,
            quantity: 1
          }
        ]
      });
      const notDispatched = await useCase.execute({
        commandId: "cmd-expedicao-nao-despachada-001",
        code: "EXP-CMD-2026-0103",
        materialRequestId: analyzed.materialRequestId,
        shippedAt: new Date("2026-09-24T21:40:00.000Z"),
        summary: "Solicitacao ainda nao despachada",
        items: [
          {
            stockPositionId: analyzed.stockPositionId,
            stockSeparationId: analyzed.stockSeparationId,
            quantity: 1
          }
        ]
      });
      const missingSeparation = await useCase.execute({
        commandId: "cmd-expedicao-separacao-ausente-001",
        code: "EXP-CMD-2026-0104",
        materialRequestId: duplicateCodeSeed.materialRequestId,
        shippedAt: new Date("2026-09-24T21:45:00.000Z"),
        summary: "Separacao inexistente",
        items: [
          {
            stockPositionId: duplicateCodeSeed.stockPositionId,
            stockSeparationId: randomUUID(),
            quantity: 1
          }
        ]
      });
      const exceedsQuantity = await useCase.execute({
        commandId: "cmd-expedicao-excede-001",
        code: "EXP-CMD-2026-0105",
        materialRequestId: duplicateCodeSeed.materialRequestId,
        shippedAt: new Date("2026-09-24T21:50:00.000Z"),
        summary: "Quantidade maior que separacao",
        items: [
          {
            stockPositionId: duplicateCodeSeed.stockPositionId,
            stockSeparationId: duplicateCodeSeed.otherStockSeparationId,
            quantity: 2
          }
        ]
      });

      expect(first).toMatchObject({ ok: true, status: "REGISTRADA" });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(duplicateCode).toEqual({ ok: false, reason: "DUPLICATE_SHIPMENT_CODE" });
      expect(missingRequest).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_FOUND" });
      expect(notDispatched).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_DISPATCHED" });
      expect(missingSeparation).toMatchObject({ ok: false, reason: "STOCK_SEPARATION_NOT_FOUND" });
      expect(exceedsQuantity).toMatchObject({
        ok: false,
        reason: "SHIPMENT_QUANTITY_EXCEEDS_SEPARATION"
      });
      await expectShipment(client, {
        materialRequestId: dispatched.materialRequestId,
        receivingEntityId: dispatched.receivingEntityId,
        expectedShipments: 1,
        expectedItems: 1,
        expectedQuantity: 2
      });
      await expectTotalShipments(client, 1);
      await expectAuditEntries(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializes concurrent shipments for the same stock separation", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedShipmentDependencies(client, { status: "DESPACHADA" });
      const useCase = new RegisterLogisticsShipment(new PostgresLogisticsShipmentRegistrar(pool));
      const common = {
        materialRequestId: seed.materialRequestId,
        shippedAt: new Date("2026-09-24T22:00:00.000Z"),
        summary: "Expedicao concorrente",
        items: [
          {
            stockPositionId: seed.stockPositionId,
            stockSeparationId: seed.otherStockSeparationId,
            quantity: 1
          }
        ]
      };

      const results = await Promise.all([
        useCase.execute({
          ...common,
          commandId: "cmd-expedicao-concorrente-001",
          code: "EXP-CMD-2026-0200"
        }),
        useCase.execute({
          ...common,
          commandId: "cmd-expedicao-concorrente-002",
          code: "EXP-CMD-2026-0201"
        })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "SHIPMENT_QUANTITY_EXCEEDS_SEPARATION",
          stockPositionId: seed.stockPositionId,
          stockSeparationId: seed.otherStockSeparationId
        }
      ]);
      await expectTotalShipments(client, 1);
      await expectAuditEntries(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectShipment(
  client: Client,
  input: {
    materialRequestId: string;
    receivingEntityId: string;
    expectedShipments: number;
    expectedItems: number;
    expectedQuantity: number;
  }
): Promise<void> {
  const shipment = await client.query<{
    shipment_count: number;
    item_count: number;
    quantity: number;
    status: string | null;
    receiving_entity_id: string | null;
  }>(
    `select count(distinct s."id")::int as shipment_count,
            count(i."id")::int as item_count,
            coalesce(sum(i."quantity"), 0)::int as quantity,
            min(s."status"::text) as status,
            min(s."receiving_entity_id"::text) as receiving_entity_id
       from "logistics_shipment" s
       left join "logistics_shipment_item" i on i."shipment_id" = s."id"
      where s."material_request_id" = $1`,
    [input.materialRequestId]
  );

  expect(shipment.rows).toEqual([
    {
      shipment_count: input.expectedShipments,
      item_count: input.expectedItems,
      quantity: input.expectedQuantity,
      status: input.expectedShipments === 0 ? null : "REGISTRADA",
      receiving_entity_id: input.expectedShipments === 0 ? null : input.receivingEntityId
    }
  ]);
}

async function expectTotalShipments(client: Client, expectedCount: number): Promise<void> {
  const shipments = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_shipment"`
  );
  const items = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_shipment_item"`
  );

  expect(shipments.rows).toEqual([{ count: expectedCount }]);
  expect(items.rows).toEqual([{ count: expectedCount }]);
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
      action: expectedCount === 0 ? null : "logistics.register_shipment",
      object_type: expectedCount === 0 ? null : "logistics_shipment"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'logistics.register_shipment'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectNoDeliverySideEffects(client: Client): Promise<void> {
  const deliveryTables = await client.query<{ count: number }>(
    `select count(*)::int as count
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('logistics_delivery', 'logistics_delivery_document')`
  );

  expect(deliveryTables.rows).toEqual([{ count: 0 }]);
}

type ShipmentSeed = {
  materialRequestId: string;
  receivingEntityId: string;
  stockPositionId: string;
  stockSeparationId: string;
  otherStockSeparationId: string;
};

async function seedShipmentDependencies(
  client: Client,
  input: { status: MaterialRequestStatus }
): Promise<ShipmentSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const receivingEntityId = randomUUID();
  const stockEntityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const stockPositionId = randomUUID();
  const firstReservationId = randomUUID();
  const secondReservationId = randomUUID();
  const stockSeparationId = randomUUID();
  const otherStockSeparationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-EXC-${suffix}`, "GRE Expedicao Command"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, `ENT-ESC-${suffix}`, "Escola Expedicao Command", greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [stockEntityId, `ENT-ALM-${suffix}`, "Almoxarifado Expedicao Command", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLE-${suffix}`, "Classe Expedicao Command"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [
      materialSingularId,
      `MTE-${suffix}`,
      "Notebook Expedicao Command",
      materialClassId,
      "EQUIPAMENTO"
    ]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      materialRequestId,
      `SOL-EXP-${suffix}`,
      receivingEntityId,
      input.status,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao para registro de expedicao",
      input.status === "DESPACHADA" ? 3 : 2
    ]
  );
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, 'PENDENTE', 10, 0, 3, 7, current_timestamp)`,
    [stockPositionId, stockEntityId, materialSingularId]
  );
  await insertStockReservation(client, {
    stockReservationId: firstReservationId,
    stockPositionId,
    code: `RES-EXP-${suffix}-1`,
    quantity: 2
  });
  await insertStockReservation(client, {
    stockReservationId: secondReservationId,
    stockPositionId,
    code: `RES-EXP-${suffix}-2`,
    quantity: 1
  });
  await insertStockSeparation(client, {
    stockSeparationId,
    stockPositionId,
    stockReservationId: firstReservationId,
    code: `SEP-EXP-${suffix}-1`,
    quantity: 2
  });
  await insertStockSeparation(client, {
    stockSeparationId: otherStockSeparationId,
    stockPositionId,
    stockReservationId: secondReservationId,
    code: `SEP-EXP-${suffix}-2`,
    quantity: 1
  });

  return {
    materialRequestId,
    receivingEntityId,
    stockPositionId,
    stockSeparationId,
    otherStockSeparationId
  };
}

async function insertStockReservation(
  client: Client,
  input: {
    stockReservationId: string;
    stockPositionId: string;
    code: string;
    quantity: number;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      input.stockReservationId,
      input.code,
      input.stockPositionId,
      input.quantity,
      "2026-09-24T18:00:00.000Z",
      "Reserva para expedicao"
    ]
  );
}

async function insertStockSeparation(
  client: Client,
  input: {
    stockSeparationId: string;
    stockPositionId: string;
    stockReservationId: string;
    code: string;
    quantity: number;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_separation" (
      "id", "code", "stock_position_id", "stock_reservation_id", "quantity", "separated_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      input.stockSeparationId,
      input.code,
      input.stockPositionId,
      input.stockReservationId,
      input.quantity,
      "2026-09-24T18:30:00.000Z",
      "Separacao para expedicao"
    ]
  );
}
