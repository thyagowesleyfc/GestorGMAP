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

describe("contracts command idempotency migration", () => {
  it("stores command results by command name and idempotency key", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'command_idempotency'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["command_idempotency"]);

      const enumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"CommandIdempotencyStatus"'::regtype
          order by enumlabel`
      );

      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
        "FAILED",
        "IN_PROGRESS",
        "SUCCEEDED"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'command_idempotency_key_not_blank',
            'command_idempotency_pkey',
            'command_idempotency_request_hash_format',
            'command_idempotency_succeeded_has_result'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "command_idempotency_key_not_blank",
        "command_idempotency_pkey",
        "command_idempotency_request_hash_format",
        "command_idempotency_succeeded_has_result"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and tablename = 'command_idempotency'
            and indexname in (
              'command_idempotency_command_key',
              'command_idempotency_status_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "command_idempotency_command_key",
        "command_idempotency_status_idx"
      ]);

      await client.query(
        `insert into "command_idempotency" (
          "id", "command_name", "idempotency_key", "request_hash", "status", "result_json", "updated_at"
        ) values ($1, $2, $3, $4, 'SUCCEEDED', $5::jsonb, current_timestamp)`,
        [
          randomUUID(),
          "contracts.emit_supply_order",
          "cmd-001",
          "a".repeat(64),
          JSON.stringify({ ok: true, supplyOrderId: randomUUID() })
        ]
      );

      await expect(
        client.query(
          `insert into "command_idempotency" (
            "id", "command_name", "idempotency_key", "request_hash", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "contracts.emit_supply_order", "cmd-001", "b".repeat(64)]
        )
      ).rejects.toThrow(/command_idempotency_command_key/);

      await expect(
        client.query(
          `insert into "command_idempotency" (
            "id", "command_name", "idempotency_key", "request_hash", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "contracts.emit_supply_order", "  ", "a".repeat(64)]
        )
      ).rejects.toThrow(/command_idempotency_key_not_blank/);

      await expect(
        client.query(
          `insert into "command_idempotency" (
            "id", "command_name", "idempotency_key", "request_hash", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "contracts.emit_supply_order", "cmd-002", "not-a-hash"]
        )
      ).rejects.toThrow(/command_idempotency_request_hash_format/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
