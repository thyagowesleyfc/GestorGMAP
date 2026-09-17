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

describe("catalog material configuration migration", () => {
  it("creates kit and composite configurations with singular components", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('material_configuration', 'material_configuration_component')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "material_configuration",
        "material_configuration_component"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_configuration_code_public_format',
            'material_configuration_component_configuration_id_fkey',
            'material_configuration_component_material_singular_id_fkey',
            'material_configuration_component_quantity_positive',
            'material_configuration_name_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_configuration_code_public_format",
        "material_configuration_component_configuration_id_fkey",
        "material_configuration_component_material_singular_id_fkey",
        "material_configuration_component_quantity_positive",
        "material_configuration_name_not_blank"
      ]);

      const classId = randomUUID();
      const monitorId = randomUUID();
      const keyboardId = randomUUID();
      const configurationId = randomUUID();

      await client.query(
        `insert into "material_class" ("id", "code", "name", "updated_at")
         values ($1, $2, $3, current_timestamp)`,
        [classId, "INFORMATICA", "Informatica"]
      );
      await client.query(
        `insert into "material_singular" (
          "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
        [monitorId, "MAT-MONITOR", "Monitor", classId, "EQUIPAMENTO"]
      );
      await client.query(
        `insert into "material_singular" (
          "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
        [keyboardId, "MAT-TECLADO", "Teclado", classId, "EQUIPAMENTO"]
      );
      await client.query(
        `insert into "material_configuration" (
          "id", "code", "name", "configuration_type", "updated_at"
        ) values ($1, $2, $3, 'COMPOSTO', current_timestamp)`,
        [configurationId, "CFG-MICROCOMPUTADOR-TIPO-VI", "Microcomputador Tipo VI"]
      );
      await client.query(
        `insert into "material_configuration_component" (
          "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
        ) values ($1, $2, $3, 1, current_timestamp)`,
        [randomUUID(), configurationId, monitorId]
      );
      await client.query(
        `insert into "material_configuration_component" (
          "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
        ) values ($1, $2, $3, 1, current_timestamp)`,
        [randomUUID(), configurationId, keyboardId]
      );

      const components = await client.query<{ material_code: string; quantity: number }>(
        `select ms."code" as material_code, mcc."quantity" as quantity
           from "material_configuration_component" mcc
           join "material_singular" ms on ms."id" = mcc."material_singular_id"
          where mcc."configuration_id" = $1
          order by ms."code"`,
        [configurationId]
      );

      expect(components.rows).toEqual([
        { material_code: "MAT-MONITOR", quantity: 1 },
        { material_code: "MAT-TECLADO", quantity: 1 }
      ]);

      await expect(
        client.query(
          `insert into "material_configuration" (
            "id", "code", "name", "configuration_type", "updated_at"
          ) values ($1, $2, $3, 'KIT', current_timestamp)`,
          [randomUUID(), "CFG-MICROCOMPUTADOR-TIPO-VI", "Configuracao duplicada"]
        )
      ).rejects.toThrow(/material_configuration_code_key/);

      await expect(
        client.query(
          `insert into "material_configuration" (
            "id", "code", "name", "configuration_type", "updated_at"
          ) values ($1, $2, $3, 'KIT', current_timestamp)`,
          [randomUUID(), "cfg-kit-lab", "Codigo minusculo"]
        )
      ).rejects.toThrow(/material_configuration_code_public_format/);

      await expect(
        client.query(
          `insert into "material_configuration" (
            "id", "code", "name", "configuration_type", "updated_at"
          ) values ($1, $2, $3, 'KIT', current_timestamp)`,
          [randomUUID(), "CFG-KIT-LAB", "  "]
        )
      ).rejects.toThrow(/material_configuration_name_not_blank/);

      await expect(
        client.query(
          `insert into "material_configuration_component" (
            "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
          ) values ($1, $2, $3, 0, current_timestamp)`,
          [randomUUID(), configurationId, monitorId]
        )
      ).rejects.toThrow(/material_configuration_component_quantity_positive/);

      await expect(
        client.query(
          `insert into "material_configuration_component" (
            "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
          ) values ($1, $2, $3, 1, current_timestamp)`,
          [randomUUID(), randomUUID(), monitorId]
        )
      ).rejects.toThrow(/material_configuration_component_configuration_id_fkey/);

      await expect(
        client.query(
          `insert into "material_configuration_component" (
            "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
          ) values ($1, $2, $3, 1, current_timestamp)`,
          [randomUUID(), configurationId, randomUUID()]
        )
      ).rejects.toThrow(/material_configuration_component_material_singular_id_fkey/);

      await expect(
        client.query(
          `insert into "material_configuration_component" (
            "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
          ) values ($1, $2, $3, 2, current_timestamp)`,
          [randomUUID(), configurationId, monitorId]
        )
      ).rejects.toThrow(/material_configuration_component_unique_item/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
