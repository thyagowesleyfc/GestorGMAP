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

describe("logistics recollection migration", () => {
  it("creates operational recollection metadata without patrimony effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('logistics_recollection')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["logistics_recollection"]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"LogisticsRecollectionStatus"'::regtype
          order by enumlabel`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual([
        "AUTORIZADA",
        "CANCELADA",
        "EXECUTADA",
        "SOLICITADA"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'logistics_recollection_authorized_at_after_requested_at',
            'logistics_recollection_authorized_status_requires_authorized_at',
            'logistics_recollection_code_public_format',
            'logistics_recollection_executed_at_after_authorized_at',
            'logistics_recollection_executed_at_after_requested_at',
            'logistics_recollection_executed_status_requires_executed_at',
            'logistics_recollection_pkey',
            'logistics_recollection_receiving_entity_id_fkey',
            'logistics_recollection_requested_by_user_id_fkey',
            'logistics_recollection_requesting_entity_id_fkey',
            'logistics_recollection_summary_not_blank',
            'logistics_recollection_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "logistics_recollection_authorized_at_after_requested_at",
        "logistics_recollection_authorized_status_requires_authorized_at",
        "logistics_recollection_code_public_format",
        "logistics_recollection_executed_at_after_authorized_at",
        "logistics_recollection_executed_at_after_requested_at",
        "logistics_recollection_executed_status_requires_executed_at",
        "logistics_recollection_pkey",
        "logistics_recollection_receiving_entity_id_fkey",
        "logistics_recollection_requested_by_user_id_fkey",
        "logistics_recollection_requesting_entity_id_fkey",
        "logistics_recollection_summary_not_blank",
        "logistics_recollection_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'logistics_recollection_authorized_at_idx',
              'logistics_recollection_code_key',
              'logistics_recollection_executed_at_idx',
              'logistics_recollection_receiving_entity_id_idx',
              'logistics_recollection_requested_at_idx',
              'logistics_recollection_requested_by_user_id_idx',
              'logistics_recollection_requesting_entity_id_idx',
              'logistics_recollection_status_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "logistics_recollection_authorized_at_idx",
        "logistics_recollection_code_key",
        "logistics_recollection_executed_at_idx",
        "logistics_recollection_receiving_entity_id_idx",
        "logistics_recollection_requested_at_idx",
        "logistics_recollection_requested_by_user_id_idx",
        "logistics_recollection_requesting_entity_id_idx",
        "logistics_recollection_status_idx"
      ]);

      const seed = await seedRecollectionDependencies(client);

      await insertRecollection(client, {
        code: "REC-LOG-2026-0001",
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedByUserId: seed.requestedByUserId,
        status: "SOLICITADA",
        requestedAt: "2026-09-26T09:00:00.000Z",
        summary: "Recolha solicitada pela entidade"
      });
      await insertRecollection(client, {
        code: "REC-LOG-2026-0002",
        requestingEntityId: seed.requestingEntityId,
        receivingEntityId: seed.receivingEntityId,
        requestedByUserId: seed.requestedByUserId,
        status: "EXECUTADA",
        requestedAt: "2026-09-26T09:00:00.000Z",
        authorizedAt: "2026-09-26T10:00:00.000Z",
        executedAt: "2026-09-26T12:00:00.000Z",
        summary: "Recolha executada pela logistica"
      });

      const patrimonyTables = await client.query<{ count: number }>(
        `select count(*)::int as count
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('patrimony', 'patrimony_movement', 'patrimony_recollection')`
      );
      expect(patrimonyTables.rows).toEqual([{ count: 0 }]);

      await expect(
        insertRecollection(client, {
          code: "rec-log-2026-0003",
          requestingEntityId: seed.requestingEntityId,
          receivingEntityId: seed.receivingEntityId,
          status: "SOLICITADA",
          requestedAt: "2026-09-26T09:00:00.000Z",
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/logistics_recollection_code_public_format/);

      await expect(
        insertRecollection(client, {
          code: "REC-LOG-2026-0003",
          requestingEntityId: seed.requestingEntityId,
          receivingEntityId: seed.receivingEntityId,
          status: "SOLICITADA",
          requestedAt: "2026-09-26T09:00:00.000Z",
          summary: " "
        })
      ).rejects.toThrow(/logistics_recollection_summary_not_blank/);

      await expect(
        insertRecollection(client, {
          code: "REC-LOG-2026-0004",
          requestingEntityId: seed.requestingEntityId,
          receivingEntityId: seed.receivingEntityId,
          status: "AUTORIZADA",
          requestedAt: "2026-09-26T09:00:00.000Z",
          summary: "Autorizada sem data"
        })
      ).rejects.toThrow(/logistics_recollection_authorized_status_requires_authorized_at/);

      await expect(
        insertRecollection(client, {
          code: "REC-LOG-2026-0005",
          requestingEntityId: seed.requestingEntityId,
          receivingEntityId: seed.receivingEntityId,
          status: "EXECUTADA",
          requestedAt: "2026-09-26T09:00:00.000Z",
          authorizedAt: "2026-09-26T10:00:00.000Z",
          summary: "Executada sem data"
        })
      ).rejects.toThrow(/logistics_recollection_executed_status_requires_executed_at/);

      await expect(
        insertRecollection(client, {
          code: "REC-LOG-2026-0006",
          requestingEntityId: seed.requestingEntityId,
          receivingEntityId: seed.receivingEntityId,
          status: "EXECUTADA",
          requestedAt: "2026-09-26T09:00:00.000Z",
          authorizedAt: "2026-09-26T12:00:00.000Z",
          executedAt: "2026-09-26T10:00:00.000Z",
          summary: "Datas incoerentes"
        })
      ).rejects.toThrow(/logistics_recollection_executed_at_after_authorized_at/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type RecollectionSeed = {
  requestingEntityId: string;
  receivingEntityId: string;
  requestedByUserId: string;
};

type RecollectionInput = {
  code: string;
  requestingEntityId: string;
  receivingEntityId: string;
  requestedByUserId?: string;
  status: "SOLICITADA" | "AUTORIZADA" | "EXECUTADA" | "CANCELADA";
  requestedAt: string;
  authorizedAt?: string;
  executedAt?: string;
  summary: string;
  version?: number;
};

async function seedRecollectionDependencies(client: Client): Promise<RecollectionSeed> {
  const greId = randomUUID();
  const requestingEntityId = randomUUID();
  const receivingEntityId = randomUUID();
  const personId = randomUUID();
  const requestedByUserId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REC", "GRE Recolha"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [requestingEntityId, "ENT-REC-ORIG", "Escola Origem Recolha", greId]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [receivingEntityId, "ENT-REC-DEST", "Gerencia Destino Recolha", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Recolha"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [requestedByUserId, personId, "recolha@gmap.local"]
  );

  return { requestingEntityId, receivingEntityId, requestedByUserId };
}

async function insertRecollection(client: Client, input: RecollectionInput): Promise<void> {
  await client.query(
    `insert into "logistics_recollection" (
      "id", "code", "requesting_entity_id", "receiving_entity_id", "requested_by_user_id",
      "status", "requested_at", "authorized_at", "executed_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_timestamp)`,
    [
      randomUUID(),
      input.code,
      input.requestingEntityId,
      input.receivingEntityId,
      input.requestedByUserId ?? null,
      input.status,
      input.requestedAt,
      input.authorizedAt ?? null,
      input.executedAt ?? null,
      input.summary,
      input.version ?? 1
    ]
  );
}
