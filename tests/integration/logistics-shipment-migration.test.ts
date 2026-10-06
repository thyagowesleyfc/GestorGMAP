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

describe("logistics shipment migration", () => {
  it("creates shipment headers for dispatched material requests without delivery side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('logistics_shipment')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["logistics_shipment"]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"LogisticsShipmentStatus"'::regtype
          order by enumlabel`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual(["REGISTRADA"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'logistics_shipment_code_public_format',
            'logistics_shipment_material_request_id_fkey',
            'logistics_shipment_pkey',
            'logistics_shipment_receiving_entity_id_fkey',
            'logistics_shipment_summary_not_blank',
            'logistics_shipment_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "logistics_shipment_code_public_format",
        "logistics_shipment_material_request_id_fkey",
        "logistics_shipment_pkey",
        "logistics_shipment_receiving_entity_id_fkey",
        "logistics_shipment_summary_not_blank",
        "logistics_shipment_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'logistics_shipment_code_key',
              'logistics_shipment_material_request_id_idx',
              'logistics_shipment_receiving_entity_id_idx',
              'logistics_shipment_shipped_at_idx',
              'logistics_shipment_status_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "logistics_shipment_code_key",
        "logistics_shipment_material_request_id_idx",
        "logistics_shipment_receiving_entity_id_idx",
        "logistics_shipment_shipped_at_idx",
        "logistics_shipment_status_idx"
      ]);

      const seed = await seedShipmentDependencies(client);

      await insertShipment(client, {
        code: "EXP-2026-0001",
        materialRequestId: seed.materialRequestId,
        receivingEntityId: seed.receivingEntityId,
        summary: "Envio inicial para escola solicitante"
      });

      await insertShipment(client, {
        code: "EXP-2026-0002",
        materialRequestId: seed.materialRequestId,
        receivingEntityId: seed.receivingEntityId,
        summary: "Segundo envio parcial"
      });

      await expect(
        insertShipment(client, {
          code: "exp-2026-0003",
          materialRequestId: seed.materialRequestId,
          receivingEntityId: seed.receivingEntityId,
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/logistics_shipment_code_public_format/);

      await expect(
        insertShipment(client, {
          code: "EXP-2026-0003",
          materialRequestId: seed.materialRequestId,
          receivingEntityId: seed.receivingEntityId,
          summary: " "
        })
      ).rejects.toThrow(/logistics_shipment_summary_not_blank/);

      await expect(
        insertShipment(client, {
          code: "EXP-2026-0004",
          materialRequestId: seed.materialRequestId,
          receivingEntityId: seed.receivingEntityId,
          summary: "Versao invalida",
          version: 0
        })
      ).rejects.toThrow(/logistics_shipment_version_positive/);

      await expect(
        insertShipment(client, {
          code: "EXP-2026-0005",
          materialRequestId: randomUUID(),
          receivingEntityId: seed.receivingEntityId,
          summary: "Solicitacao inexistente"
        })
      ).rejects.toThrow(/logistics_shipment_material_request_id_fkey/);

      await expect(
        insertShipment(client, {
          code: "EXP-2026-0006",
          materialRequestId: seed.materialRequestId,
          receivingEntityId: randomUUID(),
          summary: "Entidade inexistente"
        })
      ).rejects.toThrow(/logistics_shipment_receiving_entity_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type ShipmentSeed = {
  materialRequestId: string;
  receivingEntityId: string;
};

async function seedShipmentDependencies(client: Client): Promise<ShipmentSeed> {
  const greId = randomUUID();
  const receivingEntityId = randomUUID();
  const materialRequestId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-EXP", "GRE Expedicao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, "ENT-EXP", "Escola Recebedora", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, 3, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-EXP-0001",
      receivingEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao despachada para expedicao"
    ]
  );

  return { materialRequestId, receivingEntityId };
}

async function insertShipment(
  client: Client,
  input: {
    code: string;
    materialRequestId: string;
    receivingEntityId: string;
    summary: string;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      randomUUID(),
      input.code,
      input.materialRequestId,
      input.receivingEntityId,
      "2026-09-24T20:00:00.000Z",
      input.summary,
      input.version ?? 1
    ]
  );
}
