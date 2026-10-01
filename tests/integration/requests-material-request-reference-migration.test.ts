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

describe("material request reference migration", () => {
  it("stores normalized SEI and Redmine references for material requests", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('material_request_reference', 'external_reference')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["material_request_reference"]);

      const systems = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"MaterialRequestReferenceSystem"'::regtype
          order by enumsortorder`
      );

      expect(systems.rows.map((row) => row.enumlabel)).toEqual(["SEI", "REDMINE"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_request_reference_identifier_not_blank',
            'material_request_reference_material_request_id_fkey',
            'material_request_reference_pkey',
            'material_request_reference_type_not_blank',
            'material_request_reference_url_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_request_reference_identifier_not_blank",
        "material_request_reference_material_request_id_fkey",
        "material_request_reference_pkey",
        "material_request_reference_type_not_blank",
        "material_request_reference_url_not_blank"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'material_request_reference_material_request_id_idx',
              'material_request_reference_reference_type_idx',
              'material_request_reference_request_system_identifier_key',
              'material_request_reference_system_identifier_key',
              'material_request_reference_system_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "material_request_reference_material_request_id_idx",
        "material_request_reference_reference_type_idx",
        "material_request_reference_request_system_identifier_key",
        "material_request_reference_system_identifier_key",
        "material_request_reference_system_idx"
      ]);

      const seed = await seedMaterialRequest(client);

      await insertReference(client, {
        materialRequestId: seed.materialRequestId,
        system: "SEI",
        referenceType: "PROCESSO",
        identifier: "SEI-0001",
        url: "https://sei.example/processo/0001"
      });
      await insertReference(client, {
        materialRequestId: seed.materialRequestId,
        system: "REDMINE",
        referenceType: "TICKET",
        identifier: "RM-123"
      });

      await expect(
        insertReference(client, {
          materialRequestId: seed.materialRequestId,
          system: "SEI",
          referenceType: "PROCESSO",
          identifier: "SEI-0001"
        })
      ).rejects.toThrow(/material_request_reference_system_identifier_key/);

      await expect(
        insertReference(client, {
          materialRequestId: seed.materialRequestId,
          system: "SEI",
          referenceType: " ",
          identifier: "SEI-0002"
        })
      ).rejects.toThrow(/material_request_reference_type_not_blank/);

      await expect(
        insertReference(client, {
          materialRequestId: seed.materialRequestId,
          system: "SEI",
          referenceType: "PROCESSO",
          identifier: " "
        })
      ).rejects.toThrow(/material_request_reference_identifier_not_blank/);

      await expect(
        insertReference(client, {
          materialRequestId: seed.materialRequestId,
          system: "SEI",
          referenceType: "PROCESSO",
          identifier: "SEI-0003",
          url: " "
        })
      ).rejects.toThrow(/material_request_reference_url_not_blank/);

      await expect(
        insertReference(client, {
          materialRequestId: randomUUID(),
          system: "SEI",
          referenceType: "PROCESSO",
          identifier: "SEI-0004"
        })
      ).rejects.toThrow(/material_request_reference_material_request_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type MaterialRequestSeed = {
  materialRequestId: string;
};

async function seedMaterialRequest(client: Client): Promise<MaterialRequestSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialRequestId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REF", "GRE Referencia"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, "ENT-REF", "Escola Referencia", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "requested_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-REF-0001",
      entityId,
      "2026-09-24T13:00:00.000Z",
      "Solicitacao com referencias externas"
    ]
  );

  return { materialRequestId };
}

async function insertReference(
  client: Client,
  input: {
    materialRequestId: string;
    system: "SEI" | "REDMINE";
    referenceType: string;
    identifier: string;
    url?: string;
  }
): Promise<void> {
  await client.query(
    `insert into "material_request_reference" (
      "id", "material_request_id", "system", "reference_type", "identifier", "url", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      randomUUID(),
      input.materialRequestId,
      input.system,
      input.referenceType,
      input.identifier,
      input.url ?? null
    ]
  );
}
