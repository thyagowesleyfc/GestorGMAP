import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

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

describe("logistics shipment item migration", () => {
  it("creates shipment items linked to stock separations before delivery acceptance", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('logistics_shipment_item', 'logistics_delivery')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["logistics_shipment_item"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'logistics_shipment_item_line_number_positive',
            'logistics_shipment_item_pkey',
            'logistics_shipment_item_quantity_positive',
            'logistics_shipment_item_separation_position_fkey',
            'logistics_shipment_item_shipment_id_fkey',
            'logistics_shipment_item_stock_position_id_fkey'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "logistics_shipment_item_line_number_positive",
        "logistics_shipment_item_pkey",
        "logistics_shipment_item_quantity_positive",
        "logistics_shipment_item_separation_position_fkey",
        "logistics_shipment_item_shipment_id_fkey",
        "logistics_shipment_item_stock_position_id_fkey"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'logistics_shipment_item_shipment_id_idx',
              'logistics_shipment_item_shipment_line_key',
              'logistics_shipment_item_shipment_separation_key',
              'logistics_shipment_item_stock_position_id_idx',
              'logistics_shipment_item_stock_separation_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "logistics_shipment_item_shipment_id_idx",
        "logistics_shipment_item_shipment_line_key",
        "logistics_shipment_item_shipment_separation_key",
        "logistics_shipment_item_stock_position_id_idx",
        "logistics_shipment_item_stock_separation_id_idx"
      ]);

      const seed = await seedShipmentItemDependencies(client);

      await insertShipmentItem(client, {
        shipmentId: seed.shipmentId,
        lineNumber: 1,
        stockPositionId: seed.stockPositionId,
        stockSeparationId: seed.stockSeparationId,
        quantity: 2
      });

      await expect(
        insertShipmentItem(client, {
          shipmentId: seed.shipmentId,
          lineNumber: 0,
          stockPositionId: seed.stockPositionId,
          stockSeparationId: seed.otherStockSeparationId,
          quantity: 1
        })
      ).rejects.toThrow(/logistics_shipment_item_line_number_positive/);

      await expect(
        insertShipmentItem(client, {
          shipmentId: seed.shipmentId,
          lineNumber: 2,
          stockPositionId: seed.stockPositionId,
          stockSeparationId: seed.otherStockSeparationId,
          quantity: 0
        })
      ).rejects.toThrow(/logistics_shipment_item_quantity_positive/);

      await expect(
        insertShipmentItem(client, {
          shipmentId: randomUUID(),
          lineNumber: 1,
          stockPositionId: seed.stockPositionId,
          stockSeparationId: seed.otherStockSeparationId,
          quantity: 1
        })
      ).rejects.toThrow(/logistics_shipment_item_shipment_id_fkey/);

      await expect(
        insertShipmentItem(client, {
          shipmentId: seed.shipmentId,
          lineNumber: 1,
          stockPositionId: seed.stockPositionId,
          stockSeparationId: seed.otherStockSeparationId,
          quantity: 1
        })
      ).rejects.toThrow(/logistics_shipment_item_shipment_line_key/);

      await expect(
        insertShipmentItem(client, {
          shipmentId: seed.shipmentId,
          lineNumber: 2,
          stockPositionId: seed.stockPositionId,
          stockSeparationId: seed.stockSeparationId,
          quantity: 1
        })
      ).rejects.toThrow(/logistics_shipment_item_shipment_separation_key/);

      await expect(
        insertShipmentItem(client, {
          shipmentId: seed.otherShipmentId,
          lineNumber: 1,
          stockPositionId: seed.otherStockPositionId,
          stockSeparationId: seed.stockSeparationId,
          quantity: 1
        })
      ).rejects.toThrow(/logistics_shipment_item_separation_position_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type ShipmentItemSeed = {
  shipmentId: string;
  otherShipmentId: string;
  stockPositionId: string;
  otherStockPositionId: string;
  stockSeparationId: string;
  otherStockSeparationId: string;
};

async function seedShipmentItemDependencies(client: Client): Promise<ShipmentItemSeed> {
  const greId = randomUUID();
  const receivingEntityId = randomUUID();
  const stockEntityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const shipmentId = randomUUID();
  const otherShipmentId = randomUUID();
  const stockPositionId = randomUUID();
  const otherStockPositionId = randomUUID();
  const stockReservationId = randomUUID();
  const otherStockReservationId = randomUUID();
  const stockSeparationId = randomUUID();
  const otherStockSeparationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-EXP-ITEM", "GRE Expedicao Item"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, "ENT-EXP-ITEM", "Escola Recebedora Item", greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [stockEntityId, "ENT-EXP-STOCK", "Almoxarifado Expedicao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "INFO-EXP-ITEM", "Informatica Expedicao Item"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-EXP-NOTE", "Notebook Expedicao", materialClassId, "EQUIPAMENTO"]
  );
  await insertStockPosition(client, {
    stockPositionId,
    stockEntityId,
    materialSingularId,
    originType: "PENDENTE"
  });
  await insertStockPosition(client, {
    stockPositionId: otherStockPositionId,
    stockEntityId,
    materialSingularId,
    originType: "CONTRATUAL"
  });
  await insertStockReservation(client, {
    stockReservationId,
    stockPositionId,
    code: "RES-EXP-ITEM-0001"
  });
  await insertStockReservation(client, {
    stockReservationId: otherStockReservationId,
    stockPositionId,
    code: "RES-EXP-ITEM-0002"
  });
  await insertStockSeparation(client, {
    stockSeparationId,
    stockPositionId,
    stockReservationId,
    code: "SEP-EXP-ITEM-0001"
  });
  await insertStockSeparation(client, {
    stockSeparationId: otherStockSeparationId,
    stockPositionId,
    stockReservationId: otherStockReservationId,
    code: "SEP-EXP-ITEM-0002"
  });
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, 3, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-EXP-ITEM-0001",
      receivingEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao despachada para itens de expedicao"
    ]
  );
  await insertShipment(client, {
    shipmentId,
    code: "EXP-ITEM-2026-0001",
    materialRequestId,
    receivingEntityId
  });
  await insertShipment(client, {
    shipmentId: otherShipmentId,
    code: "EXP-ITEM-2026-0002",
    materialRequestId,
    receivingEntityId
  });

  return {
    shipmentId,
    otherShipmentId,
    stockPositionId,
    otherStockPositionId,
    stockSeparationId,
    otherStockSeparationId
  };
}

async function insertStockPosition(
  client: Client,
  input: {
    stockPositionId: string;
    stockEntityId: string;
    materialSingularId: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
  }
): Promise<void> {
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, $4, 10, 6, 4, 0, current_timestamp)`,
    [input.stockPositionId, input.stockEntityId, input.materialSingularId, input.originType]
  );
}

async function insertStockReservation(
  client: Client,
  input: {
    stockReservationId: string;
    stockPositionId: string;
    code: string;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
    ) values ($1, $2, $3, 6, $4, $5, current_timestamp)`,
    [
      input.stockReservationId,
      input.code,
      input.stockPositionId,
      "2026-09-24T16:00:00.000Z",
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
  }
): Promise<void> {
  await client.query(
    `insert into "stock_separation" (
      "id", "code", "stock_position_id", "stock_reservation_id", "quantity", "separated_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, 3, $5, $6, current_timestamp)`,
    [
      input.stockSeparationId,
      input.code,
      input.stockPositionId,
      input.stockReservationId,
      "2026-09-24T17:00:00.000Z",
      "Separacao para expedicao"
    ]
  );
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
      "Envio com itens separados"
    ]
  );
}

async function insertShipmentItem(
  client: Client,
  input: {
    shipmentId: string;
    lineNumber: number;
    stockPositionId: string;
    stockSeparationId: string;
    quantity: number;
  }
): Promise<void> {
  await client.query(
    `insert into "logistics_shipment_item" (
      "id", "shipment_id", "line_number", "stock_position_id", "stock_separation_id", "quantity", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      randomUUID(),
      input.shipmentId,
      input.lineNumber,
      input.stockPositionId,
      input.stockSeparationId,
      input.quantity
    ]
  );
}
