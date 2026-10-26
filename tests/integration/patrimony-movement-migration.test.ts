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
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("patrimony movement migration", () => {
  it("cria ledger de remanejamento imutável com invariantes estruturais", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'patrimony_movement'`
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["patrimony_movement"]);

      const enumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"PatrimonyMovementType"'::regtype
          order by enumlabel`
      );
      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
        "EMPRESTIMO",
        "RECOLHA",
        "REMANEJAMENTO"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'patrimony_movement_distinct_entities',
            'patrimony_movement_reason_not_blank',
            'patrimony_movement_correlation_id_not_blank',
            'patrimony_movement_patrimony_id_fkey',
            'patrimony_movement_from_entity_id_fkey',
            'patrimony_movement_to_entity_id_fkey'
          )
          order by conname`
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "patrimony_movement_correlation_id_not_blank",
        "patrimony_movement_distinct_entities",
        "patrimony_movement_from_entity_id_fkey",
        "patrimony_movement_patrimony_id_fkey",
        "patrimony_movement_reason_not_blank",
        "patrimony_movement_to_entity_id_fkey"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname like 'patrimony_movement%'
          order by indexname`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "patrimony_movement_from_entity_occurred_at_idx",
        "patrimony_movement_logistics_recollection_id_idx",
        "patrimony_movement_patrimony_occurred_at_idx",
        "patrimony_movement_patrimony_recollection_key",
        "patrimony_movement_pkey",
        "patrimony_movement_to_entity_occurred_at_idx"
      ]);

      const seed = await seedMovementDependencies(client);
      await client.query(
        `insert into "patrimony_movement" (
          "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
          "occurred_at", "reason", "correlation_id"
        ) values ($1, $2, 'REMANEJAMENTO', $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          seed.patrimonyId,
          seed.fromEntityId,
          seed.toEntityId,
          "2026-10-26T17:00:00.000Z",
          "Remanejamento de validação",
          "correlation-migration"
        ]
      );

      await expect(
        client.query(
          `insert into "patrimony_movement" (
            "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
            "occurred_at", "reason", "correlation_id"
          ) values ($1, $2, 'REMANEJAMENTO', $3, $3, $4, 'Motivo', 'correlation-invalid')`,
          [randomUUID(), seed.patrimonyId, seed.fromEntityId, "2026-10-26T17:00:00.000Z"]
        )
      ).rejects.toThrow(/patrimony_movement_distinct_entities/);

      await expect(
        client.query(
          `insert into "patrimony_movement" (
            "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
            "occurred_at", "reason", "correlation_id"
          ) values ($1, $2, 'REMANEJAMENTO', $3, $4, $5, ' ', 'correlation-invalid')`,
          [
            randomUUID(),
            seed.patrimonyId,
            seed.fromEntityId,
            seed.toEntityId,
            "2026-10-26T17:00:00.000Z"
          ]
        )
      ).rejects.toThrow(/patrimony_movement_reason_not_blank/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedMovementDependencies(client: Client): Promise<{
  patrimonyId: string;
  fromEntityId: string;
  toEntityId: string;
}> {
  const greId = randomUUID();
  const fromEntityId = randomUUID();
  const toEntityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, 'GRE-PAT-MOV-MIGRATION', 'GRE Movimento Migration', current_timestamp)`,
    [greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, 'ENT-PAT-MOV-FROM', 'Origem movimento', 'ESCOLA', $3, current_timestamp),
             ($2, 'ENT-PAT-MOV-TO', 'Destino movimento', 'ESCOLA', $3, current_timestamp)`,
    [fromEntityId, toEntityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-MOV-MIGRATION', 'Classe Movimento Migration', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "updated_at"
    ) values ($1, 'MAT-PAT-MOV-MIGRATION', 'Material Movimento Migration', $2, 'INDIVIDUAL', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, materialId, fromEntityId]
  );

  return { patrimonyId, fromEntityId, toEntityId };
}
