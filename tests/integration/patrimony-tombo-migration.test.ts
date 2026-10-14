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

describe("patrimony tombo migration", () => {
  it("creates patrimony identity and prevents duplicate or reused tombos", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('patrimony', 'patrimony_tombo')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["patrimony", "patrimony_tombo"]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"PatrimonyTomboStatus"'::regtype
          order by enumlabel`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual(["ATIVO", "ENCERRADO"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'patrimony_material_singular_id_fkey',
            'patrimony_pkey',
            'patrimony_responsible_entity_id_fkey',
            'patrimony_tombo_patrimony_id_fkey',
            'patrimony_tombo_patrimonial_group_format',
            'patrimony_tombo_pkey',
            'patrimony_tombo_retired_at_after_issued_at',
            'patrimony_tombo_status_retirement_consistency',
            'patrimony_tombo_tombo_format',
            'patrimony_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "patrimony_material_singular_id_fkey",
        "patrimony_pkey",
        "patrimony_responsible_entity_id_fkey",
        "patrimony_tombo_patrimonial_group_format",
        "patrimony_tombo_patrimony_id_fkey",
        "patrimony_tombo_pkey",
        "patrimony_tombo_retired_at_after_issued_at",
        "patrimony_tombo_status_retirement_consistency",
        "patrimony_tombo_tombo_format",
        "patrimony_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'patrimony_material_singular_id_idx',
              'patrimony_responsible_entity_id_idx',
              'patrimony_tombo_active_patrimony_key',
              'patrimony_tombo_issued_at_idx',
              'patrimony_tombo_patrimony_id_idx',
              'patrimony_tombo_retired_at_idx',
              'patrimony_tombo_status_idx',
              'patrimony_tombo_tombo_key'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "patrimony_material_singular_id_idx",
        "patrimony_responsible_entity_id_idx",
        "patrimony_tombo_active_patrimony_key",
        "patrimony_tombo_issued_at_idx",
        "patrimony_tombo_patrimony_id_idx",
        "patrimony_tombo_retired_at_idx",
        "patrimony_tombo_status_idx",
        "patrimony_tombo_tombo_key"
      ]);

      const seed = await seedPatrimonyDependencies(client);
      const firstPatrimonyId = await insertPatrimony(client, seed);
      const secondPatrimonyId = await insertPatrimony(client, seed);

      await insertTombo(client, {
        patrimonyId: firstPatrimonyId,
        tombo: "PI-000123/2026",
        patrimonialGroupCode: "EQUIPAMENTO"
      });

      await expect(
        insertTombo(client, {
          patrimonyId: secondPatrimonyId,
          tombo: "PI-000123/2026",
          patrimonialGroupCode: "EQUIPAMENTO"
        })
      ).rejects.toThrow(/patrimony_tombo_tombo_key/);

      await expect(
        insertTombo(client, {
          patrimonyId: firstPatrimonyId,
          tombo: "PI-000124/2026",
          patrimonialGroupCode: "EQUIPAMENTO"
        })
      ).rejects.toThrow(/patrimony_tombo_active_patrimony_key/);

      await expect(
        insertTombo(client, {
          patrimonyId: secondPatrimonyId,
          tombo: "pi-000125/2026",
          patrimonialGroupCode: "EQUIPAMENTO"
        })
      ).rejects.toThrow(/patrimony_tombo_tombo_format/);

      await expect(
        insertTombo(client, {
          patrimonyId: secondPatrimonyId,
          tombo: "PI-000126/2026",
          patrimonialGroupCode: "equipamento"
        })
      ).rejects.toThrow(/patrimony_tombo_patrimonial_group_format/);

      await expect(
        insertTombo(client, {
          patrimonyId: secondPatrimonyId,
          tombo: "PI-000127/2026",
          patrimonialGroupCode: "EQUIPAMENTO",
          status: "ENCERRADO",
          retiredAt: "2026-09-25T12:00:00.000Z",
          retirementReason: " "
        })
      ).rejects.toThrow(/patrimony_tombo_status_retirement_consistency/);

      await insertTombo(client, {
        patrimonyId: secondPatrimonyId,
        tombo: "PI-000128/2026",
        patrimonialGroupCode: "EQUIPAMENTO",
        status: "ENCERRADO",
        retiredAt: "2026-09-25T12:00:00.000Z",
        retirementReason: "Retombamento realizado"
      });

      const thirdPatrimonyId = await insertPatrimony(client, seed);
      await expect(
        insertTombo(client, {
          patrimonyId: thirdPatrimonyId,
          tombo: "PI-000128/2026",
          patrimonialGroupCode: "EQUIPAMENTO"
        })
      ).rejects.toThrow(/patrimony_tombo_tombo_key/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type PatrimonySeed = {
  materialSingularId: string;
  responsibleEntityId: string;
};

type TomboInput = {
  patrimonyId: string;
  tombo: string;
  patrimonialGroupCode: string;
  status?: "ATIVO" | "ENCERRADO";
  retiredAt?: string;
  retirementReason?: string;
};

async function seedPatrimonyDependencies(client: Client): Promise<PatrimonySeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const classId = randomUUID();
  const materialSingularId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-PAT", "GRE Patrimonio"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, "ENT-PAT", "Escola Patrimonio", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [classId, "CLASSE-PAT", "Classe Patrimonio"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-PAT", "Material Patrimonial", classId, "EQUIPAMENTO"]
  );

  return { materialSingularId, responsibleEntityId: entityId };
}

async function insertPatrimony(client: Client, seed: PatrimonySeed): Promise<string> {
  const patrimonyId = randomUUID();

  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, seed.materialSingularId, seed.responsibleEntityId]
  );

  return patrimonyId;
}

async function insertTombo(client: Client, input: TomboInput): Promise<void> {
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "status",
      "issued_at", "retired_at", "retirement_reason", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [
      randomUUID(),
      input.patrimonyId,
      input.tombo,
      input.patrimonialGroupCode,
      input.status ?? "ATIVO",
      "2026-09-25T09:00:00.000Z",
      input.retiredAt ?? null,
      input.retirementReason ?? null
    ]
  );
}
