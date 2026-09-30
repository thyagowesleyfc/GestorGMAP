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

describe("material request migration", () => {
  it("creates material requests as the base aggregate for Fase 5", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('material_request', 'material_request_reference')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["material_request"]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"MaterialRequestStatus"'::regtype
          order by enumsortorder`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual([
        "TRIAGEM",
        "NOVA",
        "ANALISADA",
        "DESPACHADA",
        "FINALIZADA"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_request_code_public_format',
            'material_request_pkey',
            'material_request_registered_by_user_id_fkey',
            'material_request_requesting_entity_id_fkey',
            'material_request_summary_not_blank',
            'material_request_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_request_code_public_format",
        "material_request_pkey",
        "material_request_registered_by_user_id_fkey",
        "material_request_requesting_entity_id_fkey",
        "material_request_summary_not_blank",
        "material_request_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'material_request_code_key',
              'material_request_registered_by_user_id_idx',
              'material_request_requested_at_idx',
              'material_request_requesting_entity_id_idx',
              'material_request_status_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "material_request_code_key",
        "material_request_registered_by_user_id_idx",
        "material_request_requested_at_idx",
        "material_request_requesting_entity_id_idx",
        "material_request_status_idx"
      ]);

      const seed = await seedMaterialRequestDependencies(client);

      await insertMaterialRequest(client, {
        code: "SOL-MAT-2026-0001",
        requestingEntityId: seed.entityId,
        requestedAt: "2026-09-24T10:00:00.000Z",
        summary: "Solicitacao inicial de monitores",
        registeredByUserId: seed.userId
      });

      await insertMaterialRequest(client, {
        code: "SOL-MAT-2026-0002",
        requestingEntityId: seed.entityId,
        status: "NOVA",
        requestedAt: "2026-09-24T11:00:00.000Z",
        summary: "Solicitacao por determinacao superior"
      });

      await expect(
        insertMaterialRequest(client, {
          code: "sol-mat-2026-0003",
          requestingEntityId: seed.entityId,
          requestedAt: "2026-09-24T12:00:00.000Z",
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/material_request_code_public_format/);

      await expect(
        insertMaterialRequest(client, {
          code: "SOL-MAT-2026-0003",
          requestingEntityId: seed.entityId,
          requestedAt: "2026-09-24T12:00:00.000Z",
          summary: " "
        })
      ).rejects.toThrow(/material_request_summary_not_blank/);

      await expect(
        insertMaterialRequest(client, {
          code: "SOL-MAT-2026-0004",
          requestingEntityId: seed.entityId,
          requestedAt: "2026-09-24T12:00:00.000Z",
          summary: "Versao invalida",
          version: 0
        })
      ).rejects.toThrow(/material_request_version_positive/);

      await expect(
        insertMaterialRequest(client, {
          code: "SOL-MAT-2026-0005",
          requestingEntityId: randomUUID(),
          requestedAt: "2026-09-24T12:00:00.000Z",
          summary: "Entidade inexistente"
        })
      ).rejects.toThrow(/material_request_requesting_entity_id_fkey/);

      await expect(
        insertMaterialRequest(client, {
          code: "SOL-MAT-2026-0006",
          requestingEntityId: seed.entityId,
          requestedAt: "2026-09-24T12:00:00.000Z",
          summary: "Usuario inexistente",
          registeredByUserId: randomUUID()
        })
      ).rejects.toThrow(/material_request_registered_by_user_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type MaterialRequestSeed = {
  entityId: string;
  userId: string;
};

async function seedMaterialRequestDependencies(client: Client): Promise<MaterialRequestSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REQ", "GRE Solicitacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, "ENT-REQ", "Escola Solicitante", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Solicitacao"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [userId, personId, "solicitacao@gmap.local"]
  );

  return { entityId, userId };
}

async function insertMaterialRequest(
  client: Client,
  input: {
    code: string;
    requestingEntityId: string;
    status?: "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";
    requestedAt: string;
    summary: string;
    registeredByUserId?: string;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "registered_by_user_id", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [
      randomUUID(),
      input.code,
      input.requestingEntityId,
      input.status ?? "TRIAGEM",
      input.requestedAt,
      input.summary,
      input.registeredByUserId ?? null,
      input.version ?? 1
    ]
  );
}
