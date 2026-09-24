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

describe("receiving entry document migration", () => {
  it("creates invoice/document metadata without implementing upload or storage adapter", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('receiving_entry_document')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["receiving_entry_document"]);

      const documentTypes = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ReceivingEntryDocumentType"'::regtype
          order by enumlabel`
      );

      expect(documentTypes.rows.map((row) => row.enumlabel)).toEqual([
        "DOCUMENTO_ENTREGA",
        "NOTA_FISCAL",
        "OUTRO"
      ]);

      const origins = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ReceivingEntryDocumentOrigin"'::regtype
          order by enumlabel`
      );

      expect(origins.rows.map((row) => row.enumlabel)).toEqual(["EXTERNO"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'receiving_entry_document_content_type_not_blank',
            'receiving_entry_document_file_metadata_complete',
            'receiving_entry_document_file_name_not_blank',
            'receiving_entry_document_invoice_access_key_format',
            'receiving_entry_document_issuer_name_not_blank',
            'receiving_entry_document_number_not_blank',
            'receiving_entry_document_receiving_entry_id_fkey',
            'receiving_entry_document_series_not_blank',
            'receiving_entry_document_sha256_format',
            'receiving_entry_document_size_positive',
            'receiving_entry_document_storage_key_not_blank',
            'receiving_entry_document_uploaded_by_user_id_fkey',
            'receiving_entry_document_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "receiving_entry_document_content_type_not_blank",
        "receiving_entry_document_file_metadata_complete",
        "receiving_entry_document_file_name_not_blank",
        "receiving_entry_document_invoice_access_key_format",
        "receiving_entry_document_issuer_name_not_blank",
        "receiving_entry_document_number_not_blank",
        "receiving_entry_document_receiving_entry_id_fkey",
        "receiving_entry_document_series_not_blank",
        "receiving_entry_document_sha256_format",
        "receiving_entry_document_size_positive",
        "receiving_entry_document_storage_key_not_blank",
        "receiving_entry_document_uploaded_by_user_id_fkey",
        "receiving_entry_document_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'receiving_entry_document_document_date_idx',
              'receiving_entry_document_document_type_idx',
              'receiving_entry_document_invoice_access_key_idx',
              'receiving_entry_document_receiving_entry_id_idx',
              'receiving_entry_document_sha256_idx',
              'receiving_entry_document_storage_key_key',
              'receiving_entry_document_uploaded_by_user_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "receiving_entry_document_document_date_idx",
        "receiving_entry_document_document_type_idx",
        "receiving_entry_document_invoice_access_key_idx",
        "receiving_entry_document_receiving_entry_id_idx",
        "receiving_entry_document_sha256_idx",
        "receiving_entry_document_storage_key_key",
        "receiving_entry_document_uploaded_by_user_id_idx"
      ]);

      const { receivingEntryId, uploadedByUserId } = await seedReceivingEntry(client);
      const validSha256 = "a".repeat(64);
      const validAccessKey = "1".repeat(44);

      await client.query(
        `insert into "receiving_entry_document" (
          "id", "receiving_entry_id", "document_type", "document_number", "document_date", "issuer_name", "invoice_access_key", "updated_at"
        ) values ($1, $2, 'NOTA_FISCAL', $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          receivingEntryId,
          "NF-123",
          "2026-09-23",
          "Fornecedor de Tecnologia Ltda",
          validAccessKey
        ]
      );

      await client.query(
        `insert into "receiving_entry_document" (
          "id", "receiving_entry_id", "document_type", "document_number", "document_date", "file_name",
          "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id", "updated_at"
        ) values ($1, $2, 'DOCUMENTO_ENTREGA', $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
        [
          randomUUID(),
          receivingEntryId,
          "REC-456",
          "2026-09-23",
          "recebimento.pdf",
          "application/pdf",
          1024,
          "receiving/ENT-2026-0001/recebimento.pdf",
          validSha256,
          uploadedByUserId
        ]
      );

      await expect(
        client.query(
          `insert into "receiving_entry_document" (
            "id", "receiving_entry_id", "document_type", "document_number", "invoice_access_key", "updated_at"
          ) values ($1, $2, 'NOTA_FISCAL', $3, $4, current_timestamp)`,
          [randomUUID(), receivingEntryId, "NF-INVALIDA", "123"]
        )
      ).rejects.toThrow(/receiving_entry_document_invoice_access_key_format/);

      await expect(
        client.query(
          `insert into "receiving_entry_document" (
            "id", "receiving_entry_id", "document_type", "document_number", "file_name",
            "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
          [
            randomUUID(),
            receivingEntryId,
            "DOC-SHA-INVALIDO",
            "arquivo.pdf",
            "application/pdf",
            1024,
            "receiving/sha-invalido.pdf",
            "ABC",
            uploadedByUserId
          ]
        )
      ).rejects.toThrow(/receiving_entry_document_sha256_format/);

      await expect(
        client.query(
          `insert into "receiving_entry_document" (
            "id", "receiving_entry_id", "document_type", "document_number", "file_name",
            "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
          [
            randomUUID(),
            receivingEntryId,
            "DOC-TAMANHO-ZERO",
            "arquivo.pdf",
            "application/pdf",
            0,
            "receiving/tamanho-zero.pdf",
            validSha256,
            uploadedByUserId
          ]
        )
      ).rejects.toThrow(/receiving_entry_document_size_positive/);

      await expect(
        client.query(
          `insert into "receiving_entry_document" (
            "id", "receiving_entry_id", "document_type", "document_number", "file_name", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, current_timestamp)`,
          [randomUUID(), receivingEntryId, "DOC-PARCIAL", "arquivo.pdf"]
        )
      ).rejects.toThrow(/receiving_entry_document_file_metadata_complete/);

      await expect(
        client.query(
          `insert into "receiving_entry_document" (
            "id", "receiving_entry_id", "document_type", "document_number", "version", "updated_at"
          ) values ($1, $2, 'OUTRO', $3, $4, current_timestamp)`,
          [randomUUID(), receivingEntryId, "DOC-VERSAO", 0]
        )
      ).rejects.toThrow(/receiving_entry_document_version_positive/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedReceivingEntry(client: Client): Promise<{
  receivingEntryId: string;
  uploadedByUserId: string;
}> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const receivingEntryId = randomUUID();
  const personId = randomUUID();
  const uploadedByUserId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-DOC", "GRE Documento"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-DOC", "Almoxarifado Documentos", greId]
  );
  await client.query(
    `insert into "receiving_entry" (
      "id", "code", "receiving_entity_id", "received_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [receivingEntryId, "ENT-2026-DOC", entityId, "2026-09-23T10:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuário de Documentos"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [uploadedByUserId, personId, "documentos.recebimento@gmap.local"]
  );

  return { receivingEntryId, uploadedByUserId };
}
