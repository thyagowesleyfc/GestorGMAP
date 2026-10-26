import { execFile } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

describe("patrimony recollection movement migration", () => {
  it("vincula RECOLHA à recolha logística executada sem quebrar os tipos anteriores", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const enumValues = await client.query<{ enumlabel: string }>(
        `select e.enumlabel
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'PatrimonyMovementType'
          order by e.enumsortorder`
      );
      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
        "REMANEJAMENTO",
        "EMPRESTIMO",
        "RECOLHA"
      ]);

      const column = await client.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'patrimony_movement'
            and column_name = 'logistics_recollection_id'`
      );
      expect(column.rows).toEqual([
        { column_name: "logistics_recollection_id", is_nullable: "YES" }
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conrelid = 'patrimony_movement'::regclass
            and conname in (
              'patrimony_movement_recollection_link_consistency',
              'patrimony_movement_logistics_recollection_id_fkey'
            )
          order by conname`
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "patrimony_movement_logistics_recollection_id_fkey",
        "patrimony_movement_recollection_link_consistency"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = current_schema()
            and tablename = 'patrimony_movement'
            and indexname in (
              'patrimony_movement_logistics_recollection_id_idx',
              'patrimony_movement_patrimony_recollection_key'
            )
          order by indexname`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "patrimony_movement_logistics_recollection_id_idx",
        "patrimony_movement_patrimony_recollection_key"
      ]);

      const seed = await seedRecollectionDependencies(client);

      await expect(
        client.query(
          `insert into "patrimony_movement" (
            "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
            "occurred_at", "reason", "correlation_id"
          ) values ($1, $2, 'RECOLHA', $3, $4, $5, 'Recolha sem vínculo', 'corr-invalid')`,
          [
            randomUUID(),
            seed.patrimonyId,
            seed.fromEntityId,
            seed.toEntityId,
            "2026-10-26T19:00:00.000Z"
          ]
        )
      ).rejects.toThrow(/patrimony_movement_recollection_link_consistency/);

      await expect(
        client.query(
          `insert into "patrimony_movement" (
            "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
            "logistics_recollection_id", "occurred_at", "reason", "correlation_id"
          ) values ($1, $2, 'REMANEJAMENTO', $3, $4, $5, $6, 'Remanejamento com vínculo', 'corr-invalid')`,
          [
            randomUUID(),
            seed.patrimonyId,
            seed.fromEntityId,
            seed.toEntityId,
            seed.recollectionId,
            "2026-10-26T19:00:00.000Z"
          ]
        )
      ).rejects.toThrow(/patrimony_movement_recollection_link_consistency/);

      await expect(
        client.query(
          `insert into "patrimony_movement" (
            "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
            "logistics_recollection_id", "occurred_at", "reason", "correlation_id"
          ) values ($1, $2, 'RECOLHA', $3, $4, $5, $6, 'Recolha sem FK', 'corr-invalid')`,
          [
            randomUUID(),
            seed.patrimonyId,
            seed.fromEntityId,
            seed.toEntityId,
            randomUUID(),
            "2026-10-26T19:00:00.000Z"
          ]
        )
      ).rejects.toThrow(/patrimony_movement_logistics_recollection_id_fkey/);

      await client.query(
        `insert into "patrimony_movement" (
          "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
          "logistics_recollection_id", "occurred_at", "reason", "correlation_id"
        ) values ($1, $2, 'RECOLHA', $3, $4, $5, $6, 'Recolha válida', 'corr-valid')`,
        [
          randomUUID(),
          seed.patrimonyId,
          seed.fromEntityId,
          seed.toEntityId,
          seed.recollectionId,
          "2026-10-26T19:00:00.000Z"
        ]
      );
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedRecollectionDependencies(client: Client): Promise<{
  patrimonyId: string;
  fromEntityId: string;
  toEntityId: string;
  recollectionId: string;
}> {
  const greId = randomUUID();
  const fromEntityId = randomUUID();
  const toEntityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();
  const recollectionId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, 'GRE-PAT-RECOLHA-MIGRATION', 'GRE Recolha Migration', current_timestamp)`,
    [greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, 'ENT-PAT-RECOLHA-MIG-FROM', 'Origem recolha migration', 'ESCOLA', $3, current_timestamp),
             ($2, 'ENT-PAT-RECOLHA-MIG-TO', 'Destino recolha migration', 'ESCOLA', $3, current_timestamp)`,
    [fromEntityId, toEntityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-RECOLHA-MIGRATION', 'Classe Recolha Migration', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "updated_at"
    ) values ($1, 'MAT-PAT-RECOLHA-MIGRATION', 'Material Recolha Migration', $2, 'INDIVIDUAL', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, materialId, fromEntityId]
  );
  await client.query(
    `insert into "logistics_recollection" (
      "id", "code", "requesting_entity_id", "receiving_entity_id", "status",
      "requested_at", "authorized_at", "executed_at", "summary", "updated_at"
    ) values ($1, 'RECOLHA-MIGRATION-EXECUTADA', $2, $3, 'EXECUTADA', $4, $5, $6, 'Recolha executada', current_timestamp)`,
    [
      recollectionId,
      fromEntityId,
      toEntityId,
      "2026-10-26T17:00:00.000Z",
      "2026-10-26T17:30:00.000Z",
      "2026-10-26T18:00:00.000Z"
    ]
  );

  return { patrimonyId, fromEntityId, toEntityId, recollectionId };
}
