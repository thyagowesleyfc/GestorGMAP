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

describe("logistics delivery document migration", () => {
  it("creates delivery document metadata without implementing upload or storage adapter", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('logistics_delivery_document')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["logistics_delivery_document"]);

      const documentTypes = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"LogisticsDeliveryDocumentType"'::regtype
          order by enumlabel`
      );

      expect(documentTypes.rows.map((row) => row.enumlabel)).toEqual([
        "COMPROVANTE_ENTREGA",
        "OUTRO",
        "TERMO_ACEITE"
      ]);

      const origins = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"LogisticsDeliveryDocumentOrigin"'::regtype
          order by enumlabel`
      );

      expect(origins.rows.map((row) => row.enumlabel)).toEqual(["EXTERNO"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'logistics_delivery_document_content_type_not_blank',
            'logistics_delivery_document_delivery_id_fkey',
            'logistics_delivery_document_file_metadata_complete',
            'logistics_delivery_document_file_name_not_blank',
            'logistics_delivery_document_issuer_name_not_blank',
            'logistics_delivery_document_number_not_blank',
            'logistics_delivery_document_pkey',
            'logistics_delivery_document_sha256_format',
            'logistics_delivery_document_size_positive',
            'logistics_delivery_document_storage_key_not_blank',
            'logistics_delivery_document_uploaded_by_user_id_fkey',
            'logistics_delivery_document_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "logistics_delivery_document_content_type_not_blank",
        "logistics_delivery_document_delivery_id_fkey",
        "logistics_delivery_document_file_metadata_complete",
        "logistics_delivery_document_file_name_not_blank",
        "logistics_delivery_document_issuer_name_not_blank",
        "logistics_delivery_document_number_not_blank",
        "logistics_delivery_document_pkey",
        "logistics_delivery_document_sha256_format",
        "logistics_delivery_document_size_positive",
        "logistics_delivery_document_storage_key_not_blank",
        "logistics_delivery_document_uploaded_by_user_id_fkey",
        "logistics_delivery_document_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'logistics_delivery_document_delivery_id_idx',
              'logistics_delivery_document_document_date_idx',
              'logistics_delivery_document_document_type_idx',
              'logistics_delivery_document_sha256_idx',
              'logistics_delivery_document_storage_key_key',
              'logistics_delivery_document_uploaded_by_user_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "logistics_delivery_document_delivery_id_idx",
        "logistics_delivery_document_document_date_idx",
        "logistics_delivery_document_document_type_idx",
        "logistics_delivery_document_sha256_idx",
        "logistics_delivery_document_storage_key_key",
        "logistics_delivery_document_uploaded_by_user_id_idx"
      ]);

      const { deliveryId, uploadedByUserId } = await seedDeliveryDocumentDependencies(client);
      const validSha256 = "a".repeat(64);

      await client.query(
        `insert into "logistics_delivery_document" (
          "id", "delivery_id", "document_type", "document_number", "document_date", "issuer_name", "updated_at"
        ) values ($1, $2, 'TERMO_ACEITE', $3, $4, $5, current_timestamp)`,
        [randomUUID(), deliveryId, "TA-123", "2026-09-25", "Escola recebedora"]
      );

      await client.query(
        `insert into "logistics_delivery_document" (
          "id", "delivery_id", "document_type", "document_number", "document_date", "file_name",
          "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id", "updated_at"
        ) values ($1, $2, 'COMPROVANTE_ENTREGA', $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
        [
          randomUUID(),
          deliveryId,
          "COMP-456",
          "2026-09-25",
          "comprovante-entrega.pdf",
          "application/pdf",
          2048,
          "logistics/delivery/ENT-2026-0001/comprovante.pdf",
          validSha256,
          uploadedByUserId
        ]
      );

      await expect(
        client.query(
          `insert into "logistics_delivery_document" (
            "id", "delivery_id", "document_type", "document_number", "file_name",
            "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
          [
            randomUUID(),
            deliveryId,
            "DOC-SHA-INVALIDO",
            "arquivo.pdf",
            "application/pdf",
            1024,
            "logistics/delivery/sha-invalido.pdf",
            "ABC",
            uploadedByUserId
          ]
        )
      ).rejects.toThrow(/logistics_delivery_document_sha256_format/);

      await expect(
        client.query(
          `insert into "logistics_delivery_document" (
            "id", "delivery_id", "document_type", "document_number", "file_name",
            "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
          [
            randomUUID(),
            deliveryId,
            "DOC-TAMANHO-ZERO",
            "arquivo.pdf",
            "application/pdf",
            0,
            "logistics/delivery/tamanho-zero.pdf",
            validSha256,
            uploadedByUserId
          ]
        )
      ).rejects.toThrow(/logistics_delivery_document_size_positive/);

      await expect(
        client.query(
          `insert into "logistics_delivery_document" (
            "id", "delivery_id", "document_type", "document_number", "file_name", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, current_timestamp)`,
          [randomUUID(), deliveryId, "DOC-PARCIAL", "arquivo.pdf"]
        )
      ).rejects.toThrow(/logistics_delivery_document_file_metadata_complete/);

      await expect(
        client.query(
          `insert into "logistics_delivery_document" (
            "id", "delivery_id", "document_type", "document_number", "version", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, current_timestamp)`,
          [randomUUID(), deliveryId, "DOC-VERSAO", 0]
        )
      ).rejects.toThrow(/logistics_delivery_document_version_positive/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedDeliveryDocumentDependencies(client: Client): Promise<{
  deliveryId: string;
  uploadedByUserId: string;
}> {
  const greId = randomUUID();
  const receivingEntityId = randomUUID();
  const materialRequestId = randomUUID();
  const shipmentId = randomUUID();
  const deliveryId = randomUUID();
  const personId = randomUUID();
  const uploadedByUserId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-DOC-ENT", "GRE Documento Entrega"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, "ENT-DOC-ENT", "Escola Documento Entrega", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, 3, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-DOC-ENT-0001",
      receivingEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao despachada para documento de entrega"
    ]
  );
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      shipmentId,
      "EXP-DOC-ENT-2026-0001",
      materialRequestId,
      receivingEntityId,
      "2026-09-24T20:00:00.000Z",
      "Envio para documento de entrega"
    ]
  );
  await client.query(
    `insert into "logistics_delivery" (
      "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "updated_at"
    ) values ($1, $2, $3, 'TOTAL', $4, $5, current_timestamp)`,
    [
      deliveryId,
      "ENT-DOC-2026-0001",
      shipmentId,
      "2026-09-25T13:00:00.000Z",
      "Entrega aceita para documento"
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Documento Entrega"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [uploadedByUserId, personId, "documentos.entrega@gmap.local"]
  );

  return { deliveryId, uploadedByUserId };
}
