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

describe("logistics delivery migration", () => {
  it("creates delivery acceptance headers without recollection", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('logistics_delivery', 'logistics_delivery_document', 'logistics_recollection')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "logistics_delivery",
        "logistics_delivery_document"
      ]);

      const statuses = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"LogisticsDeliveryAcceptanceStatus"'::regtype
          order by enumlabel`
      );

      expect(statuses.rows.map((row) => row.enumlabel)).toEqual(["PARCIAL", "RECUSADO", "TOTAL"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'logistics_delivery_code_public_format',
            'logistics_delivery_pkey',
            'logistics_delivery_shipment_id_fkey',
            'logistics_delivery_summary_not_blank',
            'logistics_delivery_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "logistics_delivery_code_public_format",
        "logistics_delivery_pkey",
        "logistics_delivery_shipment_id_fkey",
        "logistics_delivery_summary_not_blank",
        "logistics_delivery_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'logistics_delivery_acceptance_status_idx',
              'logistics_delivery_code_key',
              'logistics_delivery_delivered_at_idx',
              'logistics_delivery_shipment_id_idx',
              'logistics_delivery_shipment_id_key'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "logistics_delivery_acceptance_status_idx",
        "logistics_delivery_code_key",
        "logistics_delivery_delivered_at_idx",
        "logistics_delivery_shipment_id_idx",
        "logistics_delivery_shipment_id_key"
      ]);

      const seed = await seedDeliveryDependencies(client);

      await insertDelivery(client, {
        code: "ENT-2026-0001",
        shipmentId: seed.totalShipmentId,
        acceptanceStatus: "TOTAL",
        summary: "Entrega aceita integralmente"
      });
      await insertDelivery(client, {
        code: "ENT-2026-0002",
        shipmentId: seed.partialShipmentId,
        acceptanceStatus: "PARCIAL",
        summary: "Entrega aceita parcialmente"
      });
      await insertDelivery(client, {
        code: "ENT-2026-0003",
        shipmentId: seed.refusedShipmentId,
        acceptanceStatus: "RECUSADO",
        summary: "Entrega recusada pela entidade"
      });

      await expect(
        insertDelivery(client, {
          code: "ent-2026-0004",
          shipmentId: seed.invalidShipmentId,
          acceptanceStatus: "TOTAL",
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/logistics_delivery_code_public_format/);

      await expect(
        insertDelivery(client, {
          code: "ENT-2026-0004",
          shipmentId: seed.invalidShipmentId,
          acceptanceStatus: "TOTAL",
          summary: " "
        })
      ).rejects.toThrow(/logistics_delivery_summary_not_blank/);

      await expect(
        insertDelivery(client, {
          code: "ENT-2026-0005",
          shipmentId: seed.invalidShipmentId,
          acceptanceStatus: "TOTAL",
          summary: "Versao invalida",
          version: 0
        })
      ).rejects.toThrow(/logistics_delivery_version_positive/);

      await expect(
        insertDelivery(client, {
          code: "ENT-2026-0006",
          shipmentId: randomUUID(),
          acceptanceStatus: "TOTAL",
          summary: "Envio inexistente"
        })
      ).rejects.toThrow(/logistics_delivery_shipment_id_fkey/);

      await expect(
        insertDelivery(client, {
          code: "ENT-2026-0007",
          shipmentId: seed.totalShipmentId,
          acceptanceStatus: "TOTAL",
          summary: "Entrega duplicada para o mesmo envio"
        })
      ).rejects.toThrow(/logistics_delivery_shipment_id_key/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type DeliverySeed = {
  totalShipmentId: string;
  partialShipmentId: string;
  refusedShipmentId: string;
  invalidShipmentId: string;
};

async function seedDeliveryDependencies(client: Client): Promise<DeliverySeed> {
  const greId = randomUUID();
  const receivingEntityId = randomUUID();
  const materialRequestId = randomUUID();
  const totalShipmentId = randomUUID();
  const partialShipmentId = randomUUID();
  const refusedShipmentId = randomUUID();
  const invalidShipmentId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-ENT", "GRE Entrega"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, "ENT-ENT", "Escola Recebedora Entrega", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, 3, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-ENT-0001",
      receivingEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao despachada para entrega"
    ]
  );

  await insertShipment(client, {
    shipmentId: totalShipmentId,
    code: "EXP-ENT-2026-0001",
    materialRequestId,
    receivingEntityId
  });
  await insertShipment(client, {
    shipmentId: partialShipmentId,
    code: "EXP-ENT-2026-0002",
    materialRequestId,
    receivingEntityId
  });
  await insertShipment(client, {
    shipmentId: refusedShipmentId,
    code: "EXP-ENT-2026-0003",
    materialRequestId,
    receivingEntityId
  });
  await insertShipment(client, {
    shipmentId: invalidShipmentId,
    code: "EXP-ENT-2026-0004",
    materialRequestId,
    receivingEntityId
  });

  return { totalShipmentId, partialShipmentId, refusedShipmentId, invalidShipmentId };
}

async function insertShipment(
  client: Client,
  input: {
    shipmentId: string;
    code: string;
    materialRequestId: string;
    receivingEntityId: string;
  }
): Promise<void> {
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      input.shipmentId,
      input.code,
      input.materialRequestId,
      input.receivingEntityId,
      "2026-09-24T20:00:00.000Z",
      "Envio para aceite de entrega"
    ]
  );
}

async function insertDelivery(
  client: Client,
  input: {
    code: string;
    shipmentId: string;
    acceptanceStatus: "TOTAL" | "PARCIAL" | "RECUSADO";
    summary: string;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "logistics_delivery" (
      "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      randomUUID(),
      input.code,
      input.shipmentId,
      input.acceptanceStatus,
      "2026-09-25T12:00:00.000Z",
      input.summary,
      input.version ?? 1
    ]
  );
}
