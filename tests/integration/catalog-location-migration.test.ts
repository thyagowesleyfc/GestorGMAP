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
  it("creates GREs, municipalities and entities with stable public codes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('entity', 'gre', 'municipality')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["entity", "gre", "municipality"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'entity_code_public_format',
            'entity_gre_id_fkey',
            'entity_municipality_gre_consistency_fkey',
            'entity_municipality_id_fkey',
            'entity_name_not_blank',
            'entity_parent_entity_id_fkey',
            'entity_parent_not_self',
            'gre_code_public_format',
            'gre_name_not_blank',
            'municipality_gre_id_fkey',
            'municipality_ibge_code_public_format',
            'municipality_name_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "entity_code_public_format",
        "entity_gre_id_fkey",
        "entity_municipality_gre_consistency_fkey",
        "entity_municipality_id_fkey",
        "entity_name_not_blank",
        "entity_parent_entity_id_fkey",
        "entity_parent_not_self",
        "gre_code_public_format",
        "gre_name_not_blank",
        "municipality_gre_id_fkey",
        "municipality_ibge_code_public_format",
        "municipality_name_not_blank"
      ]);

      const greId = randomUUID();
      const secondGreId = randomUUID();
      const municipalityId = randomUUID();
      const entityId = randomUUID();
      const childEntityId = randomUUID();

      await client.query(
        `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
        [greId, "GRE-01", "1a Gerencia Regional de Educacao"]
      );
      await client.query(
        `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
        [secondGreId, "GRE-02", "2a Gerencia Regional de Educacao"]
      );
      await client.query(
        `insert into "municipality" (
          "id", "ibge_code", "name", "gre_id", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [municipalityId, "2211001", "Teresina", greId]
      );

      await client.query(
        `insert into "entity" (
          "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
        ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
        [entityId, "ENT-ESC-001", "Unidade Escolar Teste", greId, municipalityId]
      );
      await client.query(
        `insert into "entity" (
          "id", "code", "name", "entity_type", "gre_id", "municipality_id", "parent_entity_id", "updated_at"
        ) values ($1, $2, $3, 'ANEXO', $4, $5, $6, current_timestamp)`,
        [childEntityId, "ENT-ANX-001", "Anexo Escolar Teste", greId, municipalityId, entityId]
      );
      await client.query(
        `insert into "entity" (
          "id", "code", "name", "entity_type", "gre_id", "updated_at"
        ) values ($1, $2, $3, 'SECRETARIA', $4, current_timestamp)`,
        [randomUUID(), "ENT-SEC-001", "Secretaria Administrativa", greId]
      );

      const linkedRows = await client.query<{
        entity_code: string;
        entity_type: string;
        municipality_code: string | null;
        entity_gre_code: string;
        municipality_gre_code: string | null;
        parent_code: string | null;
      }>(
        `select e."code" as entity_code,
                e."entity_type"::text as entity_type,
                m."ibge_code" as municipality_code,
                entity_gre."code" as entity_gre_code,
                municipality_gre."code" as municipality_gre_code,
                parent."code" as parent_code
           from "entity" e
           join "gre" entity_gre on entity_gre."id" = e."gre_id"
      left join "municipality" m on m."id" = e."municipality_id"
      left join "gre" municipality_gre on municipality_gre."id" = m."gre_id"
      left join "entity" parent on parent."id" = e."parent_entity_id"
          where e."id" = $1`,
        [childEntityId]
      );

      expect(linkedRows.rows).toEqual([
        {
          entity_code: "ENT-ANX-001",
          entity_type: "ANEXO",
          municipality_code: "2211001",
          entity_gre_code: "GRE-01",
          municipality_gre_code: "GRE-01",
          parent_code: "ENT-ESC-001"
        }
      ]);

      await expect(
        client.query(
          `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "GRE-01", "GRE Duplicada"]
        )
      ).rejects.toThrow(/gre_code_key/);

      await expect(
        client.query(
          `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "gre-03", "GRE com Codigo Minusculo"]
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

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
          [randomUUID(), "ENT-ESC-001", "Entidade Duplicada", greId, municipalityId]
        )
      ).rejects.toThrow(/entity_code_key/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
          [randomUUID(), "ent-esc-002", "Codigo Minusculo", greId, municipalityId]
        )
      ).rejects.toThrow(/entity_code_public_format/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
          [randomUUID(), "ENT-ESC-002", "  ", greId, municipalityId]
        )
      ).rejects.toThrow(/entity_name_not_blank/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
          [randomUUID(), "ENT-ESC-003", "Entidade Sem GRE", randomUUID(), municipalityId]
        )
      ).rejects.toThrow(/entity_gre_id_fkey/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
          [randomUUID(), "ENT-ESC-004", "Entidade Sem Municipio", greId, randomUUID()]
        )
      ).rejects.toThrow(/entity_municipality_id_fkey/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, current_timestamp)`,
          [randomUUID(), "ENT-ESC-005", "Entidade Com GRE Divergente", secondGreId, municipalityId]
        )
      ).rejects.toThrow(/entity_municipality_gre_consistency_fkey/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "parent_entity_id", "updated_at"
          ) values ($1, $2, $3, 'ANEXO', $4, $5, $6, current_timestamp)`,
          [
            randomUUID(),
            "ENT-ANX-002",
            "Anexo Sem Entidade Pai",
            greId,
            municipalityId,
            randomUUID()
          ]
        )
      ).rejects.toThrow(/entity_parent_entity_id_fkey/);

      await expect(
        client.query(
          `insert into "entity" (
            "id", "code", "name", "entity_type", "gre_id", "municipality_id", "parent_entity_id", "updated_at"
          ) values ($1, $2, $3, 'ESCOLA', $4, $5, $1, current_timestamp)`,
          [randomUUID(), "ENT-ESC-006", "Entidade Pai Dela Mesma", greId, municipalityId]
        )
      ).rejects.toThrow(/entity_parent_not_self/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
