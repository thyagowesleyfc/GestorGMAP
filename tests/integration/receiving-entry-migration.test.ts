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

describe("receiving entry migration", () => {
  it("creates receiving entries and items without stock position side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('receiving_entry', 'receiving_entry_item', 'stock_position')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "receiving_entry",
        "receiving_entry_item"
      ]);

      const statusValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ReceivingEntryStatus"'::regtype
          order by enumlabel`
      );

      expect(statusValues.rows.map((row) => row.enumlabel)).toEqual(["REGISTRADA"]);

      const originValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ReceivingEntryItemOriginType"'::regtype
          order by enumlabel`
      );

      expect(originValues.rows.map((row) => row.enumlabel)).toEqual([
        "CONTRATUAL",
        "INDENIZATORIO",
        "PENDENTE"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'receiving_entry_code_public_format',
            'receiving_entry_item_catalog_reference_xor',
            'receiving_entry_item_line_number_positive',
            'receiving_entry_item_material_configuration_id_fkey',
            'receiving_entry_item_material_singular_id_fkey',
            'receiving_entry_item_quantity_positive',
            'receiving_entry_item_receiving_entry_id_fkey',
            'receiving_entry_receiving_entity_id_fkey',
            'receiving_entry_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "receiving_entry_code_public_format",
        "receiving_entry_item_catalog_reference_xor",
        "receiving_entry_item_line_number_positive",
        "receiving_entry_item_material_configuration_id_fkey",
        "receiving_entry_item_material_singular_id_fkey",
        "receiving_entry_item_quantity_positive",
        "receiving_entry_item_receiving_entry_id_fkey",
        "receiving_entry_receiving_entity_id_fkey",
        "receiving_entry_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'receiving_entry_code_key',
              'receiving_entry_item_entry_line_key',
              'receiving_entry_item_material_configuration_id_idx',
              'receiving_entry_item_material_singular_id_idx',
              'receiving_entry_item_origin_type_idx',
              'receiving_entry_item_receiving_entry_id_idx',
              'receiving_entry_received_at_idx',
              'receiving_entry_receiving_entity_id_idx',
              'receiving_entry_status_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "receiving_entry_code_key",
        "receiving_entry_item_entry_line_key",
        "receiving_entry_item_material_configuration_id_idx",
        "receiving_entry_item_material_singular_id_idx",
        "receiving_entry_item_origin_type_idx",
        "receiving_entry_item_receiving_entry_id_idx",
        "receiving_entry_received_at_idx",
        "receiving_entry_receiving_entity_id_idx",
        "receiving_entry_status_idx"
      ]);

      const { entityId, materialSingularId, configurationId } =
        await seedReceivingDependencies(client);
      const receivingEntryId = randomUUID();

      await client.query(
        `insert into "receiving_entry" (
          "id", "code", "receiving_entity_id", "received_at", "notes", "updated_at"
        ) values ($1, $2, $3, $4, $5, current_timestamp)`,
        [
          receivingEntryId,
          "ENT-2026-0001",
          entityId,
          "2026-09-23T10:00:00.000Z",
          "Entrega recebida no almoxarifado"
        ]
      );

      await client.query(
        `insert into "receiving_entry_item" (
          "id", "receiving_entry_id", "line_number", "material_singular_id", "origin_type", "quantity", "updated_at"
        ) values ($1, $2, $3, $4, 'PENDENTE', $5, current_timestamp)`,
        [randomUUID(), receivingEntryId, 1, materialSingularId, 5]
      );

      await client.query(
        `insert into "receiving_entry_item" (
          "id", "receiving_entry_id", "line_number", "material_configuration_id", "origin_type", "quantity", "updated_at"
        ) values ($1, $2, $3, $4, 'CONTRATUAL', $5, current_timestamp)`,
        [randomUUID(), receivingEntryId, 2, configurationId, 2]
      );

      await expect(
        client.query(
          `insert into "receiving_entry" (
            "id", "code", "receiving_entity_id", "received_at", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "ent-2026-0002", entityId, "2026-09-23T10:00:00.000Z"]
        )
      ).rejects.toThrow(/receiving_entry_code_public_format/);

      await expect(
        client.query(
          `insert into "receiving_entry" (
            "id", "code", "receiving_entity_id", "received_at", "version", "updated_at"
          ) values ($1, $2, $3, $4, $5, current_timestamp)`,
          [randomUUID(), "ENT-2026-0002", entityId, "2026-09-23T10:00:00.000Z", 0]
        )
      ).rejects.toThrow(/receiving_entry_version_positive/);

      await expect(
        client.query(
          `insert into "receiving_entry_item" (
            "id", "receiving_entry_id", "line_number", "material_singular_id", "origin_type", "quantity", "updated_at"
          ) values ($1, $2, $3, $4, 'PENDENTE', $5, current_timestamp)`,
          [randomUUID(), receivingEntryId, 2, materialSingularId, 1]
        )
      ).rejects.toThrow(/receiving_entry_item_entry_line_key/);

      await expect(
        client.query(
          `insert into "receiving_entry_item" (
            "id", "receiving_entry_id", "line_number", "material_singular_id", "origin_type", "quantity", "updated_at"
          ) values ($1, $2, $3, $4, 'INDENIZATORIO', $5, current_timestamp)`,
          [randomUUID(), receivingEntryId, 3, materialSingularId, 0]
        )
      ).rejects.toThrow(/receiving_entry_item_quantity_positive/);

      await expect(
        client.query(
          `insert into "receiving_entry_item" (
            "id", "receiving_entry_id", "line_number", "origin_type", "quantity", "updated_at"
          ) values ($1, $2, $3, 'PENDENTE', $4, current_timestamp)`,
          [randomUUID(), receivingEntryId, 4, 1]
        )
      ).rejects.toThrow(/receiving_entry_item_catalog_reference_xor/);

      await expect(
        client.query(
          `insert into "receiving_entry_item" (
            "id", "receiving_entry_id", "line_number", "material_singular_id", "material_configuration_id", "origin_type", "quantity", "updated_at"
          ) values ($1, $2, $3, $4, $5, 'PENDENTE', $6, current_timestamp)`,
          [randomUUID(), receivingEntryId, 5, materialSingularId, configurationId, 1]
        )
      ).rejects.toThrow(/receiving_entry_item_catalog_reference_xor/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedReceivingDependencies(client: Client): Promise<{
  entityId: string;
  materialSingularId: string;
  configurationId: string;
}> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const configurationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REC", "GRE Recebimento"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-ALMOX", "Almoxarifado Central", greId]
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
    [materialSingularId, "MAT-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_configuration" ("id", "code", "name", "configuration_type", "updated_at")
     values ($1, $2, $3, 'KIT', current_timestamp)`,
    [configurationId, "KIT-MONITOR", "Kit Monitor"]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp)`,
    [randomUUID(), configurationId, materialSingularId]
  );

  return { entityId, materialSingularId, configurationId };
}
