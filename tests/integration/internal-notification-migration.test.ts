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

describe("internal notification migration", () => {
  it("creates internal notification metadata without implementing delivery channels or UI", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('internal_notification')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["internal_notification"]);

      const targetTypes = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"InternalNotificationTargetType"'::regtype
          order by enumlabel`
      );

      expect(targetTypes.rows.map((row) => row.enumlabel)).toEqual([
        "GERENCIA",
        "LIDER",
        "TIME",
        "USER"
      ]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"InternalNotificationStatus"'::regtype
          order by enumlabel`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual([
        "ARQUIVADA",
        "CRIADA",
        "LIDA",
        "RESOLVIDA"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'internal_notification_arquivada_requires_archived_at',
            'internal_notification_body_not_blank',
            'internal_notification_correlation_id_not_blank',
            'internal_notification_lida_requires_read_at',
            'internal_notification_pkey',
            'internal_notification_related_complete',
            'internal_notification_related_id_not_blank',
            'internal_notification_related_type_not_blank',
            'internal_notification_resolvida_requires_resolved_at',
            'internal_notification_target_user_id_fkey',
            'internal_notification_team_context_not_blank',
            'internal_notification_title_not_blank',
            'internal_notification_user_target_shape'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "internal_notification_arquivada_requires_archived_at",
        "internal_notification_body_not_blank",
        "internal_notification_correlation_id_not_blank",
        "internal_notification_lida_requires_read_at",
        "internal_notification_pkey",
        "internal_notification_related_complete",
        "internal_notification_related_id_not_blank",
        "internal_notification_related_type_not_blank",
        "internal_notification_resolvida_requires_resolved_at",
        "internal_notification_target_user_id_fkey",
        "internal_notification_team_context_not_blank",
        "internal_notification_title_not_blank",
        "internal_notification_user_target_shape"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'internal_notification_correlation_id_idx',
              'internal_notification_created_at_idx',
              'internal_notification_related_lookup_idx',
              'internal_notification_status_idx',
              'internal_notification_target_type_target_team_context_idx',
              'internal_notification_target_user_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "internal_notification_correlation_id_idx",
        "internal_notification_created_at_idx",
        "internal_notification_related_lookup_idx",
        "internal_notification_status_idx",
        "internal_notification_target_type_target_team_context_idx",
        "internal_notification_target_user_id_idx"
      ]);

      const userId = await seedNotificationUser(client);

      await client.query(
        `insert into "internal_notification" (
          "id", "target_type", "target_user_id", "title", "body", "related_type", "related_id", "correlation_id", "updated_at"
        ) values ($1, 'USER', $2, $3, $4, $5, $6, $7, current_timestamp)`,
        [
          randomUUID(),
          userId,
          "Entrega registrada",
          "Uma entrega foi registrada para ciencia.",
          "logistics_delivery",
          randomUUID(),
          "corr-notif-001"
        ]
      );

      await client.query(
        `insert into "internal_notification" (
          "id", "target_type", "target_team_context", "title", "body", "action_required", "correlation_id", "updated_at"
        ) values ($1, 'GERENCIA', $2, $3, $4, true, $5, current_timestamp)`,
        [
          randomUUID(),
          "GERENCIA_MATERIAIS",
          "Ciencia gerencial",
          "Ha uma notificacao interna para ciencia da gerencia.",
          "corr-notif-002"
        ]
      );

      await expect(
        client.query(
          `insert into "internal_notification" (
            "id", "target_type", "target_team_context", "title", "body", "correlation_id", "updated_at"
          ) values ($1, 'USER', $2, $3, $4, $5, current_timestamp)`,
          [
            randomUUID(),
            "TIME_LOGISTICA",
            "Alvo invalido",
            "Usuario exige target_user_id.",
            "corr-notif-003"
          ]
        )
      ).rejects.toThrow(/internal_notification_user_target_shape/);

      await expect(
        client.query(
          `insert into "internal_notification" (
            "id", "target_type", "target_team_context", "title", "body", "related_type", "correlation_id", "updated_at"
          ) values ($1, 'TIME', $2, $3, $4, $5, $6, current_timestamp)`,
          [
            randomUUID(),
            "TIME_LOGISTICA",
            "Relacionamento invalido",
            "Relacionado incompleto.",
            "logistics_delivery",
            "corr-notif-004"
          ]
        )
      ).rejects.toThrow(/internal_notification_related_complete/);

      await expect(
        client.query(
          `insert into "internal_notification" (
            "id", "target_type", "target_team_context", "status", "title", "body", "correlation_id", "updated_at"
          ) values ($1, 'TIME', $2, 'LIDA', $3, $4, $5, current_timestamp)`,
          [
            randomUUID(),
            "TIME_LOGISTICA",
            "Lida invalida",
            "Notificacao lida exige read_at.",
            "corr-notif-005"
          ]
        )
      ).rejects.toThrow(/internal_notification_lida_requires_read_at/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedNotificationUser(client: Client): Promise<string> {
  const personId = randomUUID();
  const userId = randomUUID();

  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Notificacao"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [userId, personId, "notificacao@gmap.local"]
  );

  return userId;
}
