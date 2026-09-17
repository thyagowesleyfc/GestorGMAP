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

describe("catalog material singular migration", () => {
  it("creates singular materials with class, control and patrimony flags", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('material_class', 'material_singular')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "material_class",
        "material_singular"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_singular_class_id_fkey',
            'material_singular_code_public_format',
            'material_singular_name_not_blank',
            'material_singular_patrimonial_group_consistency'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_singular_class_id_fkey",
        "material_singular_code_public_format",
        "material_singular_name_not_blank",
        "material_singular_patrimonial_group_consistency"
      ]);

      const classId = randomUUID();

      await client.query(
        `insert into "material_class" ("id", "code", "name", "updated_at")
         values ($1, $2, $3, current_timestamp)`,
        [classId, "INFORMATICA", "Informatica"]
      );
      await client.query(
        `insert into "material_singular" (
          "id",
          "code",
          "name",
          "class_id",
          "control_type",
          "is_tombable",
          "patrimonial_group_code",
          "allows_corrective_maintenance",
          "allows_preventive_maintenance",
          "allows_reconditioning",
          "allows_replacement",
          "updated_at"
        ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, true, true, true, true, current_timestamp)`,
        [randomUUID(), "MAT-MONITOR", "Monitor", classId, "EQUIPAMENTO"]
      );
      await client.query(
        `insert into "material_singular" (
          "id", "code", "name", "class_id", "control_type", "updated_at"
        ) values ($1, $2, $3, $4, 'QUANTITATIVO', current_timestamp)`,
        [randomUUID(), "MAT-BOLA-FUTSAL", "Bola de Futsal", classId]
      );

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "updated_at"
          ) values ($1, $2, $3, $4, 'QUANTITATIVO', current_timestamp)`,
          [randomUUID(), "MAT-MONITOR", "Monitor duplicado", classId]
        )
      ).rejects.toThrow(/material_singular_code_key/);

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "updated_at"
          ) values ($1, $2, $3, $4, 'CONSUMO', current_timestamp)`,
          [randomUUID(), "mat-cabo-hdmi", "Cabo HDMI", classId]
        )
      ).rejects.toThrow(/material_singular_code_public_format/);

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "updated_at"
          ) values ($1, $2, $3, $4, 'CONSUMO', current_timestamp)`,
          [randomUUID(), "MAT-CABO-HDMI", "  ", classId]
        )
      ).rejects.toThrow(/material_singular_name_not_blank/);

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "updated_at"
          ) values ($1, $2, $3, $4, 'CONSUMO', current_timestamp)`,
          [randomUUID(), "MAT-SEM-CLASSE", "Material Sem Classe", randomUUID()]
        )
      ).rejects.toThrow(/material_singular_class_id_fkey/);

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "is_tombable", "updated_at"
          ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, current_timestamp)`,
          [randomUUID(), "MAT-TOMBAVEL-SEM-GRUPO", "Tombavel Sem Grupo", classId]
        )
      ).rejects.toThrow(/material_singular_patrimonial_group_consistency/);

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
          ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
          [randomUUID(), "MAT-GRUPO-MINUSCULO", "Grupo Minusculo", classId, "equipamento"]
        )
      ).rejects.toThrow(/material_singular_patrimonial_group_consistency/);

      await expect(
        client.query(
          `insert into "material_singular" (
            "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
          ) values ($1, $2, $3, $4, 'QUANTITATIVO', false, $5, current_timestamp)`,
          [randomUUID(), "MAT-NAO-TOMBAVEL-COM-GRUPO", "Nao Tombavel Com Grupo", classId, "CONSUMO"]
        )
      ).rejects.toThrow(/material_singular_patrimonial_group_consistency/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
