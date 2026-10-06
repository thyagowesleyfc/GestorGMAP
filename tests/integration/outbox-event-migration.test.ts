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

describe("outbox event migration", () => {
  it("creates transactional outbox metadata without implementing workers or email providers", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('outbox_event')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["outbox_event"]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"OutboxEventStatus"'::regtype
          order by enumlabel`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual(["FAILED", "PENDING", "PROCESSED"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'outbox_event_aggregate_id_not_blank',
            'outbox_event_aggregate_type_not_blank',
            'outbox_event_attempts_non_negative',
            'outbox_event_event_type_not_blank',
            'outbox_event_payload_object',
            'outbox_event_pkey',
            'outbox_event_processed_status_requires_processed_at'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "outbox_event_aggregate_id_not_blank",
        "outbox_event_aggregate_type_not_blank",
        "outbox_event_attempts_non_negative",
        "outbox_event_event_type_not_blank",
        "outbox_event_payload_object",
        "outbox_event_pkey",
        "outbox_event_processed_status_requires_processed_at"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'outbox_event_aggregate_lookup_idx',
              'outbox_event_created_at_idx',
              'outbox_event_event_type_idx',
              'outbox_event_processed_at_idx',
              'outbox_event_status_next_attempt_at_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "outbox_event_aggregate_lookup_idx",
        "outbox_event_created_at_idx",
        "outbox_event_event_type_idx",
        "outbox_event_processed_at_idx",
        "outbox_event_status_next_attempt_at_idx"
      ]);

      const aggregateId = randomUUID();
      await client.query(
        `insert into "outbox_event" (
          "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
        ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
        [
          randomUUID(),
          "logistics.delivery_registered",
          "logistics_delivery",
          aggregateId,
          JSON.stringify({ deliveryId: aggregateId, acceptanceStatus: "TOTAL" })
        ]
      );

      const pending = await client.query<{
        status: string;
        attempts: number;
        processed_at: Date | null;
      }>(
        `select "status"::text as status, "attempts", "processed_at"
           from "outbox_event"
          where "aggregate_id" = $1`,
        [aggregateId]
      );

      expect(pending.rows).toEqual([{ status: "PENDING", attempts: 0, processed_at: null }]);

      await expect(
        client.query(
          `insert into "outbox_event" (
            "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
          ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
          [randomUUID(), " ", "logistics_delivery", aggregateId, JSON.stringify({ ok: true })]
        )
      ).rejects.toThrow(/outbox_event_event_type_not_blank/);

      await expect(
        client.query(
          `insert into "outbox_event" (
            "id", "event_type", "aggregate_type", "aggregate_id", "payload", "attempts", "updated_at"
          ) values ($1, $2, $3, $4, $5::jsonb, -1, current_timestamp)`,
          [
            randomUUID(),
            "logistics.delivery_registered",
            "logistics_delivery",
            aggregateId,
            JSON.stringify({ ok: true })
          ]
        )
      ).rejects.toThrow(/outbox_event_attempts_non_negative/);

      await expect(
        client.query(
          `insert into "outbox_event" (
            "id", "event_type", "aggregate_type", "aggregate_id", "payload", "status", "updated_at"
          ) values ($1, $2, $3, $4, $5::jsonb, 'PROCESSED', current_timestamp)`,
          [
            randomUUID(),
            "logistics.delivery_registered",
            "logistics_delivery",
            aggregateId,
            JSON.stringify({ ok: true })
          ]
        )
      ).rejects.toThrow(/outbox_event_processed_status_requires_processed_at/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
