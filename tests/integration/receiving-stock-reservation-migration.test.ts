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

describe("receiving stock reservation migration", () => {
  it("creates stock reservations before devolution and locking commands", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('stock_reservation', 'stock_return')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["stock_reservation"]);

      const reservationStatuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"StockReservationStatus"'::regtype
          order by enumlabel`
      );

      expect(reservationStatuses.rows.map((row) => row.enumlabel)).toEqual(["ATIVA"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'stock_reservation_code_public_format',
            'stock_reservation_quantity_positive',
            'stock_reservation_summary_not_blank',
            'stock_reservation_version_positive',
            'stock_reservation_stock_position_id_fkey'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "stock_reservation_code_public_format",
        "stock_reservation_quantity_positive",
        "stock_reservation_stock_position_id_fkey",
        "stock_reservation_summary_not_blank",
        "stock_reservation_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'stock_reservation_code_key',
              'stock_reservation_position_status_idx',
              'stock_reservation_reserved_at_idx',
              'stock_reservation_status_idx',
              'stock_reservation_stock_position_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "stock_reservation_code_key",
        "stock_reservation_position_status_idx",
        "stock_reservation_reserved_at_idx",
        "stock_reservation_status_idx",
        "stock_reservation_stock_position_id_idx"
      ]);

      const seed = await seedStockReservationDependencies(client);

      await insertStockReservation(client, {
        code: "RES-2026-0001",
        stockPositionId: seed.stockPositionId,
        quantity: 5,
        summary: "Reserva inicial de monitores"
      });

      await insertStockReservation(client, {
        code: "RES-2026-0002",
        stockPositionId: seed.stockPositionId,
        quantity: 2,
        summary: "Segunda reserva para a mesma posicao"
      });

      await expect(
        insertStockReservation(client, {
          code: "res-2026-0003",
          stockPositionId: seed.stockPositionId,
          quantity: 1,
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/stock_reservation_code_public_format/);

      await expect(
        insertStockReservation(client, {
          code: "RES-2026-0003",
          stockPositionId: seed.stockPositionId,
          quantity: 0,
          summary: "Quantidade zero"
        })
      ).rejects.toThrow(/stock_reservation_quantity_positive/);

      await expect(
        insertStockReservation(client, {
          code: "RES-2026-0004",
          stockPositionId: seed.stockPositionId,
          quantity: -1,
          summary: "Quantidade negativa"
        })
      ).rejects.toThrow(/stock_reservation_quantity_positive/);

      await expect(
        insertStockReservation(client, {
          code: "RES-2026-0005",
          stockPositionId: seed.stockPositionId,
          quantity: 1,
          summary: " "
        })
      ).rejects.toThrow(/stock_reservation_summary_not_blank/);

      await expect(
        insertStockReservation(client, {
          code: "RES-2026-0006",
          stockPositionId: seed.stockPositionId,
          quantity: 1,
          summary: "Versao invalida",
          version: 0
        })
      ).rejects.toThrow(/stock_reservation_version_positive/);

      await expect(
        insertStockReservation(client, {
          code: "RES-2026-0007",
          stockPositionId: randomUUID(),
          quantity: 1,
          summary: "Posicao inexistente"
        })
      ).rejects.toThrow(/stock_reservation_stock_position_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type StockReservationSeed = {
  stockPositionId: string;
};

async function seedStockReservationDependencies(client: Client): Promise<StockReservationSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const stockPositionId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-RES", "GRE Reserva"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-RES", "Almoxarifado Reserva", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "INFORMATICA-RES", "Informatica Reserva"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-RES-MONITOR", "Monitor Reserva", materialClassId, "EQUIPAMENTO"]
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

async function insertStockReservation(
  client: Client,
  input: {
    code: string;
    stockPositionId: string;
    quantity: number;
    summary: string;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      randomUUID(),
      input.code,
      input.stockPositionId,
      input.quantity,
      "2026-09-23T13:00:00.000Z",
      input.summary,
      input.version ?? 1
    ]
  );
}
