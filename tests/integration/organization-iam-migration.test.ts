import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const linkTeamMembershipGreMigration = "20260916093000_link_team_membership_gre";

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

async function runMigrationsBefore(client: Client, migrationName: string): Promise<void> {
  const migrationsPath = join(process.cwd(), "prisma", "migrations");
  const migrationDirectories = (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((directoryEntry) => directoryEntry.isDirectory())
    .map((directoryEntry) => directoryEntry.name)
    .filter((name) => name < migrationName)
    .sort();

  for (const migrationDirectory of migrationDirectories) {
    const migrationSql = await readFile(
      join(migrationsPath, migrationDirectory, "migration.sql"),
      "utf8"
    );
    await client.query(migrationSql);
  }
}

async function runMigration(client: Client, migrationName: string): Promise<void> {
  const migrationSql = await readFile(
    join(process.cwd(), "prisma", "migrations", migrationName, "migration.sql"),
    "utf8"
  );

  await client.query(migrationSql);
}
describe("organization IAM migration", () => {
  it("rejects linking GRE-scoped memberships when legacy rows reference missing canonical GREs", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const client = new Client({ connectionString: databaseUrl });

    try {
      await client.connect();
      await runMigrationsBefore(client, linkTeamMembershipGreMigration);

      const personId = randomUUID();
      const userId = randomUUID();
      const teamId = randomUUID();

      await client.query(
        `insert into "person" ("id", "display_name", "updated_at") values ($1, $2, current_timestamp)`,
        [personId, "Pessoa Legada"]
      );
      await client.query(
        `insert into "user_account" (
          "id", "person_id", "login_identifier", "updated_at"
        ) values ($1, $2, $3, current_timestamp)`,
        [userId, personId, "pessoa.legada"]
      );
      await client.query(
        `insert into "team" ("id", "name", "updated_at") values ($1, $2, current_timestamp)`,
        [teamId, "Equipe Legada"]
      );
      await client.query(
        `insert into "team_membership" (
          "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
        ) values ($1, $2, $3, 'MEMBRO', 'GRE', 'GRE-99', current_timestamp)`,
        [randomUUID(), userId, teamId]
      );

      await expect(runMigration(client, linkTeamMembershipGreMigration)).rejects.toThrow(
        /orphan GRE scope codes exist: GRE-99/
      );
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("applies the schema and enforces core IAM constraints", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const client = new Client({ connectionString: databaseUrl });

    async function createPerson(displayName: string): Promise<string> {
      const personId = randomUUID();

      await client.query(
        `insert into "person" ("id", "display_name", "updated_at") values ($1, $2, current_timestamp)`,
        [personId, displayName]
      );

      return personId;
    }

    try {
      await runPrismaMigrateDeploy(databaseUrl);
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'person',
              'password_credential',
              'password_recovery_request',
              'user_account',
              'user_session',
              'team',
              'team_membership'
            )
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "password_credential",
        "password_recovery_request",
        "person",
        "team",
        "team_membership",
        "user_account",
        "user_session"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'password_credential_hash_not_blank',
            'password_recovery_request_expires_after_created',
            'password_recovery_request_token_hash_not_blank',
            'password_recovery_request_used_after_created',
            'person_display_name_not_blank',
            'team_name_not_blank',
            'team_membership_gre_code_fkey',
            'team_membership_scope_consistency',
            'user_account_login_identifier_normalized',
            'user_session_expires_after_created',
            'user_session_revoked_after_created',
            'user_session_token_hash_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "password_credential_hash_not_blank",
        "password_recovery_request_expires_after_created",
        "password_recovery_request_token_hash_not_blank",
        "password_recovery_request_used_after_created",
        "person_display_name_not_blank",
        "team_membership_gre_code_fkey",
        "team_membership_scope_consistency",
        "team_name_not_blank",
        "user_account_login_identifier_normalized",
        "user_session_expires_after_created",
        "user_session_revoked_after_created",
        "user_session_token_hash_not_blank"
      ]);

      const personId = await createPerson("Pessoa Teste");
      const secondPersonId = await createPerson("Pessoa Sem Credencial");
      const userId = randomUUID();
      const secondUserId = randomUUID();
      const teamId = randomUUID();

      await client.query(
        `insert into "user_account" (
          "id", "person_id", "login_identifier", "updated_at"
        ) values ($1, $2, $3, current_timestamp)`,
        [userId, personId, "pessoa.teste"]
      );
      await client.query(
        `insert into "user_account" (
          "id", "person_id", "login_identifier", "updated_at"
        ) values ($1, $2, $3, current_timestamp)`,
        [secondUserId, secondPersonId, "pessoa.sem.credencial"]
      );
      await client.query(
        `insert into "password_credential" (
          "id", "user_id", "password_hash", "updated_at"
        ) values ($1, $2, $3, current_timestamp)`,
        [randomUUID(), userId, "scrypt$v1$16384$8$1$c2FsdA==$aGFzaA=="]
      );
      await client.query(
        `insert into "user_session" (
          "id", "user_id", "session_token_hash", "expires_at", "updated_at"
        ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp)`,
        [randomUUID(), userId, "sha256:token-hash-um"]
      );
      await client.query(
        `insert into "user_session" (
          "id", "user_id", "session_token_hash", "expires_at", "updated_at"
        ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp)`,
        [randomUUID(), userId, "sha256:token-hash-dois"]
      );
      await client.query(
        `insert into "user_session" (
          "id", "user_id", "session_token_hash", "expires_at", "revoked_at", "updated_at"
        ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp, current_timestamp)`,
        [randomUUID(), userId, "sha256:token-hash-revogado"]
      );
      await client.query(
        `insert into "password_recovery_request" (
          "id", "user_id", "recovery_token_hash", "expires_at", "updated_at"
        ) values ($1, $2, $3, current_timestamp + interval '15 minutes', current_timestamp)`,
        [randomUUID(), userId, "sha256:recovery-token-hash-um"]
      );

      const activeSessions = await client.query<{ session_token_hash: string }>(
        `select "session_token_hash"
           from "user_session"
          where "user_id" = $1
            and "revoked_at" is null
            and "expires_at" > current_timestamp
          order by "session_token_hash"`,
        [userId]
      );

      expect(activeSessions.rows.map((row) => row.session_token_hash)).toEqual([
        "sha256:token-hash-dois",
        "sha256:token-hash-um"
      ]);

      await client.query(
        `insert into "team" ("id", "name", "updated_at") values ($1, $2, current_timestamp)`,
        [teamId, "Equipe Teste"]
      );
      await client.query(
        `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, $3, current_timestamp)`,
        [randomUUID(), "GRE-01", "1a Gerencia Regional de Educacao"]
      );
      await client.query(
        `insert into "team_membership" (
          "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
        ) values ($1, $2, $3, 'MEMBRO', 'GRE', 'GRE-01', current_timestamp)`,
        [randomUUID(), userId, teamId]
      );

      await expect(
        client.query(
          `insert into "user_account" (
            "id", "person_id", "login_identifier", "updated_at"
          ) values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), await createPerson("Pessoa Login Duplicado"), "pessoa.teste"]
        )
      ).rejects.toThrow(/user_account_login_identifier_key/);

      await expect(
        client.query(
          `insert into "user_account" (
            "id", "person_id", "login_identifier", "updated_at"
          ) values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), await createPerson("Pessoa Login Maiusculo"), "Pessoa.Teste"]
        )
      ).rejects.toThrow(/user_account_login_identifier_normalized/);

      await expect(
        client.query(
          `insert into "user_account" (
            "id", "person_id", "login_identifier", "updated_at"
          ) values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), await createPerson("Pessoa Login Vazio"), "  "]
        )
      ).rejects.toThrow(/user_account_login_identifier_normalized/);

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
          `insert into "user_session" (
            "id", "user_id", "session_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp)`,
          [randomUUID(), userId, "sha256:token-hash-um"]
        )
      ).rejects.toThrow(/user_session_session_token_hash_key/);

      await expect(
        client.query(
          `insert into "user_session" (
            "id", "user_id", "session_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp)`,
          [randomUUID(), secondUserId, "  "]
        )
      ).rejects.toThrow(/user_session_token_hash_not_blank/);

      await expect(
        client.query(
          `insert into "user_session" (
            "id", "user_id", "session_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp - interval '1 second', current_timestamp)`,
          [randomUUID(), secondUserId, "sha256:expired-token-hash"]
        )
      ).rejects.toThrow(/user_session_expires_after_created/);

      await expect(
        client.query(
          `insert into "user_session" (
            "id", "user_id", "session_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp)`,
          [randomUUID(), randomUUID(), "sha256:unknown-user-token-hash"]
        )
      ).rejects.toThrow(/user_session_user_id_fkey/);

      await expect(
        client.query(
          `insert into "password_recovery_request" (
            "id", "user_id", "recovery_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp + interval '15 minutes', current_timestamp)`,
          [randomUUID(), userId, "sha256:recovery-token-hash-um"]
        )
      ).rejects.toThrow(/password_recovery_request_recovery_token_hash_key/);

      await expect(
        client.query(
          `insert into "password_recovery_request" (
            "id", "user_id", "recovery_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp + interval '15 minutes', current_timestamp)`,
          [randomUUID(), secondUserId, "  "]
        )
      ).rejects.toThrow(/password_recovery_request_token_hash_not_blank/);

      await expect(
        client.query(
          `insert into "password_recovery_request" (
            "id", "user_id", "recovery_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp - interval '1 second', current_timestamp)`,
          [randomUUID(), secondUserId, "sha256:expired-recovery-token-hash"]
        )
      ).rejects.toThrow(/password_recovery_request_expires_after_created/);

      await expect(
        client.query(
          `insert into "password_recovery_request" (
            "id", "user_id", "recovery_token_hash", "expires_at", "used_at", "updated_at"
          ) values (
            $1,
            $2,
            $3,
            current_timestamp + interval '15 minutes',
            current_timestamp - interval '1 second',
            current_timestamp
          )`,
          [randomUUID(), secondUserId, "sha256:used-before-created-recovery-token-hash"]
        )
      ).rejects.toThrow(/password_recovery_request_used_after_created/);

      await expect(
        client.query(
          `insert into "password_recovery_request" (
            "id", "user_id", "recovery_token_hash", "expires_at", "updated_at"
          ) values ($1, $2, $3, current_timestamp + interval '15 minutes', current_timestamp)`,
          [randomUUID(), randomUUID(), "sha256:unknown-user-recovery-token-hash"]
        )
      ).rejects.toThrow(/password_recovery_request_user_id_fkey/);

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
          ) values ($1, $2, $3, 'MEMBRO', 'GRE', 'gre-01', current_timestamp)`,
          [randomUUID(), userId, teamId]
        )
      ).rejects.toThrow(/team_membership_scope_consistency/);

      await expect(
        client.query(
          `insert into "team_membership" (
            "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
          ) values ($1, $2, $3, 'MEMBRO', 'GRE', 'GRE-99', current_timestamp)`,
          [randomUUID(), userId, teamId]
        )
      ).rejects.toThrow(/team_membership_gre_code_fkey/);

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
