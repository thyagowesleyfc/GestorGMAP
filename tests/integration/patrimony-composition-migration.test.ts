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

describe("patrimony composition migration", () => {
  it("persists versioned configuration and component snapshots", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('patrimony_composition', 'patrimony_composition_item')
          order by table_name`
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "patrimony_composition",
        "patrimony_composition_item"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'patrimony_composition_revision_positive',
            'patrimony_composition_configuration_code_public_format',
            'patrimony_composition_configuration_name_not_blank',
            'patrimony_composition_item_line_positive',
            'patrimony_composition_item_quantity_positive',
            'patrimony_composition_item_material_code_public_format',
            'patrimony_composition_item_material_name_not_blank',
            'patrimony_composition_item_tombable_snapshot_consistency',
            'patrimony_composition_patrimony_id_fkey',
            'patrimony_composition_material_configuration_id_fkey',
            'patrimony_composition_item_composition_id_fkey',
            'patrimony_composition_item_material_singular_id_fkey',
            'patrimony_composition_item_component_patrimony_id_fkey'
          )
          order by conname`
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "patrimony_composition_configuration_code_public_format",
        "patrimony_composition_configuration_name_not_blank",
        "patrimony_composition_item_component_patrimony_id_fkey",
        "patrimony_composition_item_composition_id_fkey",
        "patrimony_composition_item_line_positive",
        "patrimony_composition_item_material_code_public_format",
        "patrimony_composition_item_material_name_not_blank",
        "patrimony_composition_item_material_singular_id_fkey",
        "patrimony_composition_item_quantity_positive",
        "patrimony_composition_item_tombable_snapshot_consistency",
        "patrimony_composition_material_configuration_id_fkey",
        "patrimony_composition_patrimony_id_fkey",
        "patrimony_composition_revision_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname like 'patrimony_composition%'
          order by indexname`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "patrimony_composition_item_component_patrimony_id_idx",
        "patrimony_composition_item_composition_line_key",
        "patrimony_composition_item_composition_material_key",
        "patrimony_composition_item_material_singular_id_idx",
        "patrimony_composition_item_pkey",
        "patrimony_composition_material_configuration_id_idx",
        "patrimony_composition_patrimony_recorded_at_idx",
        "patrimony_composition_patrimony_revision_key",
        "patrimony_composition_pkey"
      ]);

      const seed = await seedComposition(client);

      await client.query(
        `insert into "patrimony_composition" (
          "id", "patrimony_id", "revision", "material_configuration_id",
          "configuration_code", "configuration_name", "configuration_type",
          "recorded_at", "updated_at"
        ) values ($1, $2, 1, $3, $4, $5, 'COMPOSTO', $6, current_timestamp)`,
        [
          seed.compositionId,
          seed.ownerPatrimonyId,
          seed.configurationId,
          "CFG-MICRO-TIPO-VI",
          "Microcomputador Tipo VI",
          "2026-10-26T12:00:00.000Z"
        ]
      );

      await client.query(
        `insert into "patrimony_composition_item" (
          "id", "composition_id", "line_number", "material_singular_id",
          "component_patrimony_id", "quantity", "material_code", "material_name",
          "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, 1, $3, $4, 1, $5, $6, true, '01', current_timestamp),
                 ($7, $2, 2, $8, null, 2, $9, $10, false, null, current_timestamp)`,
        [
          randomUUID(),
          seed.compositionId,
          seed.tombableComponentId,
          seed.componentPatrimonyId,
          "MAT-MONITOR",
          "Monitor",
          randomUUID(),
          seed.quantitativeComponentId,
          "MAT-TECLADO",
          "Teclado"
        ]
      );

      await client.query(
        `update "material_configuration"
            set "code" = 'CFG-MICRO-TIPO-VII',
                "name" = 'Microcomputador Tipo VII',
                "updated_at" = current_timestamp
          where "id" = $1`,
        [seed.configurationId]
      );

      const snapshot = await client.query<{
        configuration_code: string;
        configuration_name: string;
        material_code: string;
      }>(
        `select pc."configuration_code", pc."configuration_name", pci."material_code"
           from "patrimony_composition" pc
           join "patrimony_composition_item" pci on pci."composition_id" = pc."id"
          where pc."id" = $1
            and pci."line_number" = 1`,
        [seed.compositionId]
      );
      expect(snapshot.rows).toEqual([
        {
          configuration_code: "CFG-MICRO-TIPO-VI",
          configuration_name: "Microcomputador Tipo VI",
          material_code: "MAT-MONITOR"
        }
      ]);

      await expect(
        client.query(
          `insert into "patrimony_composition" (
            "id", "patrimony_id", "revision", "material_configuration_id",
            "configuration_code", "configuration_name", "configuration_type",
            "recorded_at", "updated_at"
          ) values ($1, $2, 1, $3, 'CFG-MICRO-TIPO-VI', 'Duplicada', 'COMPOSTO', $4, current_timestamp)`,
          [randomUUID(), seed.ownerPatrimonyId, seed.configurationId, "2026-10-26T12:01:00.000Z"]
        )
      ).rejects.toThrow(/patrimony_composition_patrimony_revision_key/);

      await expect(
        client.query(
          `insert into "patrimony_composition_item" (
            "id", "composition_id", "line_number", "material_singular_id", "quantity",
            "material_code", "material_name", "is_tombable", "updated_at"
          ) values ($1, $2, 3, $3, 0, 'MAT-TECLADO', 'Teclado', false, current_timestamp)`,
          [randomUUID(), seed.compositionId, seed.additionalComponentId]
        )
      ).rejects.toThrow(/patrimony_composition_item_quantity_positive/);

      await expect(
        client.query(
          `insert into "patrimony_composition_item" (
            "id", "composition_id", "line_number", "material_singular_id", "quantity",
            "material_code", "material_name", "is_tombable", "updated_at"
          ) values ($1, $2, 3, $3, 1, 'MAT-TECLADO', 'Teclado', true, current_timestamp)`,
          [randomUUID(), seed.compositionId, seed.additionalComponentId]
        )
      ).rejects.toThrow(/patrimony_composition_item_tombable_snapshot_consistency/);

      await expect(
        client.query(
          `insert into "patrimony_composition_item" (
            "id", "composition_id", "line_number", "material_singular_id", "quantity",
            "material_code", "material_name", "is_tombable", "updated_at"
          ) values ($1, $2, 3, $3, 1, 'MAT-INVALIDO', 'Invalido', false, current_timestamp)`,
          [randomUUID(), seed.compositionId, randomUUID()]
        )
      ).rejects.toThrow(/patrimony_composition_item_material_singular_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type CompositionSeed = {
  configurationId: string;
  ownerPatrimonyId: string;
  compositionId: string;
  tombableComponentId: string;
  quantitativeComponentId: string;
  additionalComponentId: string;
  componentPatrimonyId: string;
};

async function seedComposition(client: Client): Promise<CompositionSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const classId = randomUUID();
  const ownerMaterialId = randomUUID();
  const tombableComponentId = randomUUID();
  const quantitativeComponentId = randomUUID();
  const additionalComponentId = randomUUID();
  const configurationId = randomUUID();
  const ownerPatrimonyId = randomUUID();
  const componentPatrimonyId = randomUUID();
  const compositionId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, 'GRE-PAT-COMP', 'GRE Patrimonio Composicao', current_timestamp)`,
    [greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, 'ENT-PAT-COMP', 'Entidade Patrimonio Composicao', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-COMP', 'Classe Patrimonio Composicao', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-MICRO', 'Microcomputador', $2, 'INDIVIDUAL', true, '01', current_timestamp),
             ($3, 'MAT-MONITOR', 'Monitor', $2, 'INDIVIDUAL', true, '01', current_timestamp),
             ($4, 'MAT-TECLADO', 'Teclado', $2, 'QUANTITATIVO', false, null, current_timestamp),
             ($5, 'MAT-CABO', 'Cabo', $2, 'QUANTITATIVO', false, null, current_timestamp)`,
    [ownerMaterialId, classId, tombableComponentId, quantitativeComponentId, additionalComponentId]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, 'CFG-MICRO-TIPO-VI', 'Microcomputador Tipo VI', 'COMPOSTO', current_timestamp)`,
    [configurationId]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp),
             ($4, $2, $5, 2, current_timestamp)`,
    [randomUUID(), configurationId, tombableComponentId, randomUUID(), quantitativeComponentId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp),
             ($4, $5, $3, current_timestamp)`,
    [ownerPatrimonyId, ownerMaterialId, entityId, componentPatrimonyId, tombableComponentId]
  );

  return {
    configurationId,
    ownerPatrimonyId,
    compositionId,
    tombableComponentId,
    quantitativeComponentId,
    additionalComponentId,
    componentPatrimonyId
  };
}
