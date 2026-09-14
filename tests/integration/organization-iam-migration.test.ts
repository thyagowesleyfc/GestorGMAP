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

describe("organization IAM migration", () => {
  it("applies the schema and enforces core IAM constraints", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const client = new Client({ connectionString: databaseUrl });

    try {
      await runPrismaMigrateDeploy(databaseUrl);
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('person', 'password_credential', 'user_account', 'team', 'team_membership')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "password_credential",
        "person",
        "team",
        "team_membership",
        "user_account"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'password_credential_hash_not_blank',
            'person_display_name_not_blank',
            'team_name_not_blank',
            'team_membership_scope_consistency'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "password_credential_hash_not_blank",
        "person_display_name_not_blank",
        "team_membership_scope_consistency",
        "team_name_not_blank"
      ]);

      const personId = randomUUID();
      const userId = randomUUID();
      const secondPersonId = randomUUID();
      const secondUserId = randomUUID();
      const teamId = randomUUID();

      await client.query(
        `insert into "person" ("id", "display_name", "updated_at") values ($1, $2, current_timestamp)`,
        [personId, "Pessoa Teste"]
      );
      await client.query(
        `insert into "person" ("id", "display_name", "updated_at") values ($1, $2, current_timestamp)`,
        [secondPersonId, "Pessoa Sem Credencial"]
      );
      await client.query(
        `insert into "user_account" ("id", "person_id", "updated_at") values ($1, $2, current_timestamp)`,
        [userId, personId]
      );
      await client.query(
        `insert into "user_account" ("id", "person_id", "updated_at") values ($1, $2, current_timestamp)`,
        [secondUserId, secondPersonId]
      );
      await client.query(
        `insert into "password_credential" (
          "id", "user_id", "password_hash", "updated_at"
        ) values ($1, $2, $3, current_timestamp)`,
        [randomUUID(), userId, "scrypt$v1$16384$8$1$c2FsdA==$aGFzaA=="]
      );
      await client.query(
        `insert into "team" ("id", "name", "updated_at") values ($1, $2, current_timestamp)`,
        [teamId, "Equipe Teste"]
      );
      await client.query(
        `insert into "team_membership" (
          "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
        ) values ($1, $2, $3, 'MEMBRO', 'GRE', 'GRE-01', current_timestamp)`,
        [randomUUID(), userId, teamId]
      );

      await expect(
        client.query(
          `insert into "password_credential" (
            "id", "user_id", "password_hash", "updated_at"
          ) values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), userId, "scrypt$v1$16384$8$1$c2FsdA==$b3V0cm8="]
        )
      ).rejects.toThrow(/password_credential_user_id_key/);

      await expect(
        client.query(
          `insert into "password_credential" (
            "id", "user_id", "password_hash", "updated_at"
          ) values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), secondUserId, "  "]
        )
      ).rejects.toThrow(/password_credential_hash_not_blank/);

      await expect(
        client.query(
          `insert into "password_credential" (
            "id", "user_id", "password_hash", "updated_at"
          ) values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), randomUUID(), "scrypt$v1$16384$8$1$c2FsdA==$aGFzaA=="]
        )
      ).rejects.toThrow(/password_credential_user_id_fkey/);

      await expect(
        client.query(
          `insert into "team_membership" (
            "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
          ) values ($1, $2, $3, 'MEMBRO', 'GRE', null, current_timestamp)`,
          [randomUUID(), userId, teamId]
        )
      ).rejects.toThrow(/team_membership_scope_consistency/);

      await expect(
        client.query(
          `insert into "team_membership" (
            "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
          ) values ($1, $2, $3, 'LIDER', 'GRE', 'GRE-01', current_timestamp)`,
          [randomUUID(), userId, teamId]
        )
      ).rejects.toThrow(/team_membership_active_scope_key/);

      await client.query(
        `insert into "team_membership" (
          "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
        ) values ($1, $2, $3, 'LIDER', 'GRE', 'GRE-01', false, current_timestamp)`,
        [randomUUID(), userId, teamId]
      );
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
