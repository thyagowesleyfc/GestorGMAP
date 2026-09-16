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

describe("catalog location migration", () => {
  it("creates GREs and municipalities with stable public codes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('gre', 'municipality')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["gre", "municipality"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'gre_code_public_format',
            'gre_name_not_blank',
            'municipality_gre_id_fkey',
            'municipality_ibge_code_public_format',
            'municipality_name_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "gre_code_public_format",
        "gre_name_not_blank",
        "municipality_gre_id_fkey",
        "municipality_ibge_code_public_format",
        "municipality_name_not_blank"
      ]);

      const greId = randomUUID();
      const municipalityId = randomUUID();

      await client.query(
        `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
        [greId, "GRE-01", "1a Gerencia Regional de Educacao"]
      );
      await client.query(
        `insert into "municipality" (
          "id", "ibge_code", "name", "gre_id", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [municipalityId, "2211001", "Teresina", greId]
      );

      const linkedRows = await client.query<{ municipality_code: string; gre_code: string }>(
        `select m."ibge_code" as municipality_code, g."code" as gre_code
           from "municipality" m
           join "gre" g on g."id" = m."gre_id"
          where m."id" = $1`,
        [municipalityId]
      );

      expect(linkedRows.rows).toEqual([{ municipality_code: "2211001", gre_code: "GRE-01" }]);

      await expect(
        client.query(
          `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "GRE-01", "GRE Duplicada"]
        )
      ).rejects.toThrow(/gre_code_key/);

      await expect(
        client.query(
          `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "gre-02", "GRE com Codigo Minusculo"]
        )
      ).rejects.toThrow(/gre_code_public_format/);

      await expect(
        client.query(
          `insert into "municipality" (
            "id", "ibge_code", "name", "gre_id", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "2211001", "Teresina Duplicada", greId]
        )
      ).rejects.toThrow(/municipality_ibge_code_key/);

      await expect(
        client.query(
          `insert into "municipality" (
            "id", "ibge_code", "name", "gre_id", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "22110", "Codigo IBGE Invalido", greId]
        )
      ).rejects.toThrow(/municipality_ibge_code_public_format/);

      await expect(
        client.query(
          `insert into "municipality" (
            "id", "ibge_code", "name", "gre_id", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "2207702", "Municipio Sem GRE", randomUUID()]
        )
      ).rejects.toThrow(/municipality_gre_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
