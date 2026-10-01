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

describe("material request item migration", () => {
  it("stores requested quantities by catalog item without authorization side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'material_request_item'
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["material_request_item"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_request_item_catalog_reference_xor',
            'material_request_item_line_number_positive',
            'material_request_item_material_configuration_id_fkey',
            'material_request_item_material_request_id_fkey',
            'material_request_item_material_singular_id_fkey',
            'material_request_item_pkey',
            'material_request_item_requested_quantity_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_request_item_catalog_reference_xor",
        "material_request_item_line_number_positive",
        "material_request_item_material_configuration_id_fkey",
        "material_request_item_material_request_id_fkey",
        "material_request_item_material_singular_id_fkey",
        "material_request_item_pkey",
        "material_request_item_requested_quantity_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'material_request_item_material_configuration_id_idx',
              'material_request_item_material_request_id_idx',
              'material_request_item_material_singular_id_idx',
              'material_request_item_request_line_key'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "material_request_item_material_configuration_id_idx",
        "material_request_item_material_request_id_idx",
        "material_request_item_material_singular_id_idx",
        "material_request_item_request_line_key"
      ]);

      const seed = await seedMaterialRequestItemDependencies(client);

      await insertMaterialRequestItem(client, {
        materialRequestId: seed.materialRequestId,
        lineNumber: 1,
        materialSingularId: seed.materialSingularId,
        requestedQuantity: 3
      });

      await insertMaterialRequestItem(client, {
        materialRequestId: seed.materialRequestId,
        lineNumber: 2,
        materialConfigurationId: seed.configurationId,
        requestedQuantity: 1
      });

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 2,
          materialSingularId: seed.materialSingularId,
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_request_line_key/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 0,
          materialSingularId: seed.materialSingularId,
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_line_number_positive/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 3,
          materialSingularId: seed.materialSingularId,
          requestedQuantity: 0
        })
      ).rejects.toThrow(/material_request_item_requested_quantity_positive/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 4,
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_catalog_reference_xor/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 5,
          materialSingularId: seed.materialSingularId,
          materialConfigurationId: seed.configurationId,
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_catalog_reference_xor/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: randomUUID(),
          lineNumber: 6,
          materialSingularId: seed.materialSingularId,
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_material_request_id_fkey/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 7,
          materialSingularId: randomUUID(),
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_material_singular_id_fkey/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 8,
          materialConfigurationId: randomUUID(),
          requestedQuantity: 1
        })
      ).rejects.toThrow(/material_request_item_material_configuration_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type MaterialRequestItemSeed = {
  materialRequestId: string;
  materialSingularId: string;
  configurationId: string;
};

async function seedMaterialRequestItemDependencies(
  client: Client
): Promise<MaterialRequestItemSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialRequestId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const configurationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REQ-ITEM", "GRE Item Solicitacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, "ENT-REQ-ITEM", "Escola Item Solicitacao", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "requested_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-ITEM-0001",
      entityId,
      "2026-09-24T14:00:00.000Z",
      "Solicitacao com itens de material"
    ]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "REQITEM", "Materiais solicitaveis"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-REQ-MON", "Monitor solicitado", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_configuration" ("id", "code", "name", "configuration_type", "updated_at")
     values ($1, $2, $3, 'KIT', current_timestamp)`,
    [configurationId, "KIT-REQ-MON", "Kit solicitado"]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp)`,
    [randomUUID(), configurationId, materialSingularId]
  );

  return { materialRequestId, materialSingularId, configurationId };
}

async function insertMaterialRequestItem(
  client: Client,
  input: {
    materialRequestId: string;
    lineNumber: number;
    materialSingularId?: string;
    materialConfigurationId?: string;
    requestedQuantity: number;
  }
): Promise<void> {
  await client.query(
    `insert into "material_request_item" (
      "id", "material_request_id", "line_number", "material_singular_id", "material_configuration_id", "requested_quantity", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      randomUUID(),
      input.materialRequestId,
      input.lineNumber,
      input.materialSingularId ?? null,
      input.materialConfigurationId ?? null,
      input.requestedQuantity
    ]
  );
}
