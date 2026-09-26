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

describe("receiving stock position migration", () => {
  it("creates stock positions before separation tables", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('stock_position', 'stock_separation')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["stock_position"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'stock_position_available_consistent',
            'stock_position_catalog_reference_xor',
            'stock_position_material_configuration_id_fkey',
            'stock_position_material_singular_id_fkey',
            'stock_position_quantities_non_negative',
            'stock_position_stock_entity_id_fkey',
            'stock_position_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "stock_position_available_consistent",
        "stock_position_catalog_reference_xor",
        "stock_position_material_configuration_id_fkey",
        "stock_position_material_singular_id_fkey",
        "stock_position_quantities_non_negative",
        "stock_position_stock_entity_id_fkey",
        "stock_position_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'stock_position_entity_configuration_origin_key',
              'stock_position_entity_singular_origin_key',
              'stock_position_material_configuration_id_idx',
              'stock_position_material_singular_id_idx',
              'stock_position_origin_type_idx',
              'stock_position_stock_entity_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "stock_position_entity_configuration_origin_key",
        "stock_position_entity_singular_origin_key",
        "stock_position_material_configuration_id_idx",
        "stock_position_material_singular_id_idx",
        "stock_position_origin_type_idx",
        "stock_position_stock_entity_id_idx"
      ]);

      const seed = await seedStockPositionDependencies(client);

      await insertStockPosition(client, {
        stockEntityId: seed.entityId,
        materialSingularId: seed.materialSingularId,
        originType: "PENDENTE",
        physicalQuantity: 10,
        reservedQuantity: 2,
        separatingQuantity: 3,
        availableQuantity: 5
      });

      await insertStockPosition(client, {
        stockEntityId: seed.entityId,
        materialConfigurationId: seed.configurationId,
        originType: "INDENIZATORIO",
        physicalQuantity: 4,
        reservedQuantity: 0,
        separatingQuantity: 0,
        availableQuantity: 4
      });

      await insertStockPosition(client, {
        stockEntityId: seed.entityId,
        materialSingularId: seed.materialSingularId,
        originType: "CONTRATUAL",
        physicalQuantity: 1,
        reservedQuantity: 0,
        separatingQuantity: 0,
        availableQuantity: 1
      });

      await expect(
        insertStockPosition(client, {
          stockEntityId: seed.entityId,
          materialSingularId: seed.materialSingularId,
          originType: "PENDENTE",
          physicalQuantity: 1,
          reservedQuantity: 0,
          separatingQuantity: 0,
          availableQuantity: 1
        })
      ).rejects.toThrow(/stock_position_entity_singular_origin_key/);

      await expect(
        insertStockPosition(client, {
          stockEntityId: seed.entityId,
          originType: "PENDENTE",
          physicalQuantity: 1,
          reservedQuantity: 0,
          separatingQuantity: 0,
          availableQuantity: 1
        })
      ).rejects.toThrow(/stock_position_catalog_reference_xor/);

      await expect(
        insertStockPosition(client, {
          stockEntityId: seed.entityId,
          materialSingularId: seed.materialSingularId,
          materialConfigurationId: seed.configurationId,
          originType: "PENDENTE",
          physicalQuantity: 1,
          reservedQuantity: 0,
          separatingQuantity: 0,
          availableQuantity: 1
        })
      ).rejects.toThrow(/stock_position_catalog_reference_xor/);

      await expect(
        insertStockPosition(client, {
          stockEntityId: seed.entityId,
          materialConfigurationId: seed.configurationId,
          originType: "CONTRATUAL",
          physicalQuantity: -1,
          reservedQuantity: 0,
          separatingQuantity: 0,
          availableQuantity: -1
        })
      ).rejects.toThrow(/stock_position_quantities_non_negative/);

      await expect(
        insertStockPosition(client, {
          stockEntityId: seed.entityId,
          materialConfigurationId: seed.configurationId,
          originType: "CONTRATUAL",
          physicalQuantity: 10,
          reservedQuantity: 3,
          separatingQuantity: 2,
          availableQuantity: 6
        })
      ).rejects.toThrow(/stock_position_available_consistent/);

      await expect(
        insertStockPosition(client, {
          stockEntityId: seed.entityId,
          materialConfigurationId: seed.configurationId,
          originType: "CONTRATUAL",
          physicalQuantity: 1,
          reservedQuantity: 0,
          separatingQuantity: 0,
          availableQuantity: 1,
          version: 0
        })
      ).rejects.toThrow(/stock_position_version_positive/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type StockPositionSeed = {
  entityId: string;
  materialSingularId: string;
  configurationId: string;
};

async function seedStockPositionDependencies(client: Client): Promise<StockPositionSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const configurationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-POS", "GRE Posicao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-POS", "Almoxarifado Posicao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "INFORMATICA", "Informatica"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-POS-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_configuration" ("id", "code", "name", "configuration_type", "updated_at")
     values ($1, $2, $3, 'KIT', current_timestamp)`,
    [configurationId, "KIT-POS", "Kit Posicao"]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp)`,
    [randomUUID(), configurationId, materialSingularId]
  );

  return { entityId, materialSingularId, configurationId };
}

async function insertStockPosition(
  client: Client,
  input: {
    stockEntityId: string;
    materialSingularId?: string;
    materialConfigurationId?: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
    physicalQuantity: number;
    reservedQuantity: number;
    separatingQuantity: number;
    availableQuantity: number;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "material_configuration_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
    [
      randomUUID(),
      input.stockEntityId,
      input.materialSingularId ?? null,
      input.materialConfigurationId ?? null,
      input.originType,
      input.physicalQuantity,
      input.reservedQuantity,
      input.separatingQuantity,
      input.availableQuantity,
      input.version ?? 1
    ]
  );
}
