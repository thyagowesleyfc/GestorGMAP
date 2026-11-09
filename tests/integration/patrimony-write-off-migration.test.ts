import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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

describe("patrimony write-off migration", () => {
  it("cria estado, motivos e evidência estrutural da Baixa", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const statuses = await client.query<{ enumlabel: string }>(
        `select e.enumlabel
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'PatrimonyOperationalState'
          order by e.enumsortorder`
      );
      expect(statuses.rows.map((row) => row.enumlabel)).toEqual([
        "EM_USO",
        "RECOLHIDO",
        "EM_MANUTENCAO",
        "BAIXADO"
      ]);

      const reasons = await client.query<{ enumlabel: string }>(
        `select e.enumlabel
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'PatrimonyWriteOffReason'
          order by e.enumsortorder`
      );
      expect(reasons.rows.map((row) => row.enumlabel)).toEqual([
        "INSERVIBILIDADE",
        "FURTO",
        "PERDA"
      ]);

      const columns = await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = current_schema()
            and ((table_name = 'patrimony' and column_name = 'operational_state')
              or (table_name = 'patrimony_write_off' and column_name in (
                'reason', 'occurred_at', 'justification',
                'procedure_or_report_reference', 'authorization_reference', 'correlation_id'
              )))
          order by table_name, column_name`
      );
      expect(columns.rows).toEqual([
        { table_name: "patrimony", column_name: "operational_state" },
        { table_name: "patrimony_write_off", column_name: "authorization_reference" },
        { table_name: "patrimony_write_off", column_name: "correlation_id" },
        { table_name: "patrimony_write_off", column_name: "justification" },
        { table_name: "patrimony_write_off", column_name: "occurred_at" },
        { table_name: "patrimony_write_off", column_name: "procedure_or_report_reference" },
        { table_name: "patrimony_write_off", column_name: "reason" }
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conrelid = 'patrimony_write_off'::regclass
            and conname like 'patrimony_write_off_%'
          order by conname`
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "patrimony_write_off_authorization_reference_not_blank",
        "patrimony_write_off_correlation_id_not_blank",
        "patrimony_write_off_justification_not_blank",
        "patrimony_write_off_patrimony_id_fkey",
        "patrimony_write_off_pkey",
        "patrimony_write_off_procedure_reference_not_blank"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = current_schema()
            and tablename = 'patrimony_write_off'
          order by indexname`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "patrimony_write_off_occurred_at_idx",
        "patrimony_write_off_patrimony_id_key",
        "patrimony_write_off_pkey",
        "patrimony_write_off_reason_idx"
      ]);

      const seed = await seedWriteOffDependencies(client);

      await client.query(
        `insert into "patrimony_write_off" (
          "id", "patrimony_id", "reason", "occurred_at", "justification", "correlation_id"
        ) values ($1, $2, 'FURTO', $3, 'Ocorrência registrada', 'corr-valid')`,
        [randomUUID(), seed.patrimonyId, "2026-11-09T18:00:00.000Z"]
      );

      await expect(
        client.query(
          `insert into "patrimony_write_off" (
            "id", "patrimony_id", "reason", "occurred_at", "justification", "correlation_id"
          ) values ($1, $2, 'PERDA', $3, 'Segunda baixa', 'corr-duplicate')`,
          [randomUUID(), seed.patrimonyId, "2026-11-09T18:00:00.000Z"]
        )
      ).rejects.toThrow(/patrimony_write_off_patrimony_id_key/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedWriteOffDependencies(client: Client): Promise<{ patrimonyId: string }> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, 'GRE-PAT-WRITEOFF-MIGRATION', 'GRE Write Off Migration', current_timestamp)`,
    [greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, 'ENT-PAT-WRITEOFF-MIGRATION', 'Entidade Write Off Migration', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-WRITEOFF-MIGRATION', 'Classe Write Off Migration', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "updated_at"
    ) values ($1, 'MAT-PAT-WRITEOFF-MIGRATION', 'Material Write Off Migration', $2, 'INDIVIDUAL', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, materialId, entityId]
  );

  return { patrimonyId };
}
