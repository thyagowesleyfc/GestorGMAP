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

describe("receiving stock separation migration", () => {
  it("creates stock separations before devolution, locks and logistics commands", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('stock_separation', 'stock_return', 'stock_dispatch')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["stock_separation"]);

      const separationStatuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"StockSeparationStatus"'::regtype
          order by enumlabel`
      );

      expect(separationStatuses.rows.map((row) => row.enumlabel)).toEqual(["EM_SEPARACAO"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'stock_separation_code_public_format',
            'stock_separation_quantity_positive',
            'stock_separation_reservation_position_fkey',
            'stock_separation_stock_position_id_fkey',
            'stock_separation_summary_not_blank',
            'stock_separation_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "stock_separation_code_public_format",
        "stock_separation_quantity_positive",
        "stock_separation_reservation_position_fkey",
        "stock_separation_stock_position_id_fkey",
        "stock_separation_summary_not_blank",
        "stock_separation_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'stock_reservation_id_position_id_key',
              'stock_separation_code_key',
              'stock_separation_position_status_idx',
              'stock_separation_reservation_status_idx',
              'stock_separation_separated_at_idx',
              'stock_separation_status_idx',
              'stock_separation_stock_position_id_idx',
              'stock_separation_stock_reservation_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "stock_reservation_id_position_id_key",
        "stock_separation_code_key",
        "stock_separation_position_status_idx",
        "stock_separation_reservation_status_idx",
        "stock_separation_separated_at_idx",
        "stock_separation_status_idx",
        "stock_separation_stock_position_id_idx",
        "stock_separation_stock_reservation_id_idx"
      ]);

      const seed = await seedStockSeparationDependencies(client);

      await insertStockSeparation(client, {
        code: "SEP-2026-0001",
        stockPositionId: seed.stockPositionId,
        stockReservationId: seed.stockReservationId,
        quantity: 4,
        summary: "Separacao inicial de monitores"
      });

      await insertStockSeparation(client, {
        code: "SEP-2026-0002",
        stockPositionId: seed.stockPositionId,
        stockReservationId: seed.stockReservationId,
        quantity: 1,
        summary: "Separacao parcial adicional"
      });

      await expect(
        insertStockSeparation(client, {
          code: "sep-2026-0003",
          stockPositionId: seed.stockPositionId,
          stockReservationId: seed.stockReservationId,
          quantity: 1,
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/stock_separation_code_public_format/);

      await expect(
        insertStockSeparation(client, {
          code: "SEP-2026-0003",
          stockPositionId: seed.stockPositionId,
          stockReservationId: seed.stockReservationId,
          quantity: 0,
          summary: "Quantidade zero"
        })
      ).rejects.toThrow(/stock_separation_quantity_positive/);

      await expect(
        insertStockSeparation(client, {
          code: "SEP-2026-0004",
          stockPositionId: seed.stockPositionId,
          stockReservationId: seed.stockReservationId,
          quantity: -1,
          summary: "Quantidade negativa"
        })
      ).rejects.toThrow(/stock_separation_quantity_positive/);

      await expect(
        insertStockSeparation(client, {
          code: "SEP-2026-0005",
          stockPositionId: seed.stockPositionId,
          stockReservationId: seed.stockReservationId,
          quantity: 1,
          summary: " "
        })
      ).rejects.toThrow(/stock_separation_summary_not_blank/);

      await expect(
        insertStockSeparation(client, {
          code: "SEP-2026-0006",
          stockPositionId: seed.stockPositionId,
          stockReservationId: seed.stockReservationId,
          quantity: 1,
          summary: "Versao invalida",
          version: 0
        })
      ).rejects.toThrow(/stock_separation_version_positive/);

      await expect(
        insertStockSeparation(client, {
          code: "SEP-2026-0007",
          stockPositionId: seed.otherStockPositionId,
          stockReservationId: seed.stockReservationId,
          quantity: 1,
          summary: "Reserva incoerente com posicao"
        })
      ).rejects.toThrow(/stock_separation_reservation_position_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type StockSeparationSeed = {
  stockPositionId: string;
  otherStockPositionId: string;
  stockReservationId: string;
};

async function seedStockSeparationDependencies(client: Client): Promise<StockSeparationSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const stockPositionId = randomUUID();
  const otherStockPositionId = randomUUID();
  const stockReservationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-SEP", "GRE Separacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-SEP", "Almoxarifado Separacao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "INFORMATICA-SEP", "Informatica Separacao"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-SEP-MONITOR", "Monitor Separacao", materialClassId, "EQUIPAMENTO"]
  );
  await insertStockPosition(client, {
    stockPositionId,
    entityId,
    materialSingularId,
    originType: "PENDENTE"
  });
  await insertStockPosition(client, {
    stockPositionId: otherStockPositionId,
    entityId,
    materialSingularId,
    originType: "CONTRATUAL"
  });
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
    ) values ($1, $2, $3, 6, $4, $5, current_timestamp)`,
    [
      stockReservationId,
      "RES-SEP-0001",
      stockPositionId,
      "2026-09-23T13:00:00.000Z",
      "Reserva para separacao"
    ]
  );

  return { stockPositionId, otherStockPositionId, stockReservationId };
}

async function insertStockPosition(
  client: Client,
  input: {
    stockPositionId: string;
    entityId: string;
    materialSingularId: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
  }
): Promise<void> {
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, $4, 10, 6, 0, 4, current_timestamp)`,
    [input.stockPositionId, input.entityId, input.materialSingularId, input.originType]
  );
}

async function insertStockSeparation(
  client: Client,
  input: {
    code: string;
    stockPositionId: string;
    stockReservationId: string;
    quantity: number;
    summary: string;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_separation" (
      "id", "code", "stock_position_id", "stock_reservation_id", "quantity", "separated_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [
      randomUUID(),
      input.code,
      input.stockPositionId,
      input.stockReservationId,
      input.quantity,
      "2026-09-23T14:00:00.000Z",
      input.summary,
      input.version ?? 1
    ]
  );
}
