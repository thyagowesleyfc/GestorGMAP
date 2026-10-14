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

describe("patrimony incorporation source migration", () => {
  it("links incorporated patrimonies to delivery and shipment item source", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const columns = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'patrimony'
            and column_name in ('source_delivery_id', 'source_shipment_item_id', 'incorporated_at')
          order by column_name`
      );

      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "incorporated_at",
        "source_delivery_id",
        "source_shipment_item_id"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'patrimony_incorporation_source_consistency',
            'patrimony_source_delivery_id_fkey',
            'patrimony_source_shipment_item_id_fkey'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "patrimony_incorporation_source_consistency",
        "patrimony_source_delivery_id_fkey",
        "patrimony_source_shipment_item_id_fkey"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'patrimony_incorporated_at_idx',
              'patrimony_source_delivery_id_idx',
              'patrimony_source_shipment_item_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "patrimony_incorporated_at_idx",
        "patrimony_source_delivery_id_idx",
        "patrimony_source_shipment_item_id_idx"
      ]);

      const seed = await seedIncorporationSource(client);

      await client.query(
        `insert into "patrimony" (
          "id", "material_singular_id", "responsible_entity_id", "source_delivery_id",
          "source_shipment_item_id", "incorporated_at", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          seed.materialSingularId,
          seed.responsibleEntityId,
          seed.deliveryId,
          seed.shipmentItemId,
          "2026-09-25T16:00:00.000Z"
        ]
      );

      await expect(
        client.query(
          `insert into "patrimony" (
            "id", "material_singular_id", "responsible_entity_id", "source_delivery_id", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), seed.materialSingularId, seed.responsibleEntityId, seed.deliveryId]
        )
      ).rejects.toThrow(/patrimony_incorporation_source_consistency/);

      await expect(
        client.query(
          `insert into "patrimony" (
            "id", "material_singular_id", "responsible_entity_id", "source_delivery_id",
            "source_shipment_item_id", "incorporated_at", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [
            randomUUID(),
            seed.materialSingularId,
            seed.responsibleEntityId,
            randomUUID(),
            seed.shipmentItemId,
            "2026-09-25T16:00:00.000Z"
          ]
        )
      ).rejects.toThrow(/patrimony_source_delivery_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type IncorporationSourceSeed = {
  materialSingularId: string;
  responsibleEntityId: string;
  deliveryId: string;
  shipmentItemId: string;
};

async function seedIncorporationSource(client: Client): Promise<IncorporationSourceSeed> {
  const greId = randomUUID();
  const responsibleEntityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const stockPositionId = randomUUID();
  const reservationId = randomUUID();
  const separationId = randomUUID();
  const shipmentId = randomUUID();
  const shipmentItemId = randomUUID();
  const deliveryId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-PAT-SRC", "GRE Patrimonio Origem"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [responsibleEntityId, "ENT-PAT-SRC", "Escola Patrimonio Origem", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "CL-PAT-SRC", "Classe Patrimonio Origem"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-PAT-SRC", "Material Patrimonial Origem", materialClassId, "01"]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, current_timestamp)`,
    [
      materialRequestId,
      "SOL-PAT-SRC-0001",
      responsibleEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao para origem patrimonial"
    ]
  );
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, 'PENDENTE', 1, 0, 0, 1, current_timestamp)`,
    [stockPositionId, responsibleEntityId, materialSingularId]
  );
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
    ) values ($1, $2, $3, 1, $4, $5, current_timestamp)`,
    [
      reservationId,
      "RES-PAT-SRC-0001",
      stockPositionId,
      "2026-09-24T20:00:00.000Z",
      "Reserva para origem patrimonial"
    ]
  );
  await client.query(
    `insert into "stock_separation" (
      "id", "code", "stock_position_id", "stock_reservation_id", "quantity", "separated_at",
      "summary", "updated_at"
    ) values ($1, $2, $3, $4, 1, $5, $6, current_timestamp)`,
    [
      separationId,
      "SEP-PAT-SRC-0001",
      stockPositionId,
      reservationId,
      "2026-09-24T20:30:00.000Z",
      "Separacao para origem patrimonial"
    ]
  );
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      shipmentId,
      "EXP-PAT-SRC-0001",
      materialRequestId,
      responsibleEntityId,
      "2026-09-24T21:00:00.000Z",
      "Expedicao para origem patrimonial"
    ]
  );
  await client.query(
    `insert into "logistics_shipment_item" (
      "id", "shipment_id", "line_number", "stock_position_id", "stock_separation_id", "quantity", "updated_at"
    ) values ($1, $2, 1, $3, $4, 1, current_timestamp)`,
    [shipmentItemId, shipmentId, stockPositionId, separationId]
  );
  await client.query(
    `insert into "logistics_delivery" (
      "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "updated_at"
    ) values ($1, $2, $3, 'TOTAL', $4, $5, current_timestamp)`,
    [
      deliveryId,
      "ENT-PAT-SRC-0001",
      shipmentId,
      "2026-09-25T16:00:00.000Z",
      "Entrega para origem patrimonial"
    ]
  );

  return { materialSingularId, responsibleEntityId, deliveryId, shipmentItemId };
}
