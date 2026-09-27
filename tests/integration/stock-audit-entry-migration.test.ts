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

describe("stock audit entry migration", () => {
  it("creates append-only audit entries for command observability", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'audit_entry'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["audit_entry"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'audit_entry_action_not_blank',
            'audit_entry_actor_user_id_fkey',
            'audit_entry_correlation_id_not_blank',
            'audit_entry_object_id_not_blank',
            'audit_entry_object_type_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "audit_entry_action_not_blank",
        "audit_entry_actor_user_id_fkey",
        "audit_entry_correlation_id_not_blank",
        "audit_entry_object_id_not_blank",
        "audit_entry_object_type_not_blank"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'audit_entry_action_idx',
              'audit_entry_actor_user_id_idx',
              'audit_entry_correlation_id_idx',
              'audit_entry_object_lookup_idx',
              'audit_entry_occurred_at_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "audit_entry_action_idx",
        "audit_entry_actor_user_id_idx",
        "audit_entry_correlation_id_idx",
        "audit_entry_object_lookup_idx",
        "audit_entry_occurred_at_idx"
      ]);

      const actorUserId = await seedAuditActor(client);

      await insertAuditEntry(client, {
        actorUserId,
        action: "stock.reserve_stock",
        objectType: "stock_reservation",
        objectId: "reserva-1",
        correlationId: "corr-audit-1"
      });

      await expect(
        insertAuditEntry(client, {
          actorUserId,
          action: " ",
          objectType: "stock_reservation",
          objectId: "reserva-2",
          correlationId: "corr-audit-2"
        })
      ).rejects.toThrow(/audit_entry_action_not_blank/);

      await expect(
        insertAuditEntry(client, {
          actorUserId,
          action: "stock.reserve_stock",
          objectType: " ",
          objectId: "reserva-3",
          correlationId: "corr-audit-3"
        })
      ).rejects.toThrow(/audit_entry_object_type_not_blank/);

      await expect(
        insertAuditEntry(client, {
          actorUserId,
          action: "stock.reserve_stock",
          objectType: "stock_reservation",
          objectId: " ",
          correlationId: "corr-audit-4"
        })
      ).rejects.toThrow(/audit_entry_object_id_not_blank/);

      await expect(
        insertAuditEntry(client, {
          actorUserId,
          action: "stock.reserve_stock",
          objectType: "stock_reservation",
          objectId: "reserva-5",
          correlationId: " "
        })
      ).rejects.toThrow(/audit_entry_correlation_id_not_blank/);

      await expect(
        insertAuditEntry(client, {
          actorUserId: randomUUID(),
          action: "stock.reserve_stock",
          objectType: "stock_reservation",
          objectId: "reserva-6",
          correlationId: "corr-audit-6"
        })
      ).rejects.toThrow(/audit_entry_actor_user_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedAuditActor(client: Client): Promise<string> {
  const personId = randomUUID();
  const userId = randomUUID();

  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Auditor"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [userId, personId, `auditor-${userId}@example.test`]
  );

  return userId;
}

async function insertAuditEntry(
  client: Client,
  input: {
    actorUserId: string;
    action: string;
    objectType: string;
    objectId: string;
    correlationId: string;
  }
): Promise<void> {
  await client.query(
    `insert into "audit_entry" (
      "id", "actor_user_id", "action", "object_type", "object_id", "previous_value", "next_value", "reason", "correlation_id"
    ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      randomUUID(),
      input.actorUserId,
      input.action,
      input.objectType,
      input.objectId,
      JSON.stringify({ availableQuantity: 10 }),
      JSON.stringify({ availableQuantity: 0 }),
      "Reserva auditada",
      input.correlationId
    ]
  );
}
