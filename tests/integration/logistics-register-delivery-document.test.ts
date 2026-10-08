import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterLogisticsDeliveryDocument } from "../../src/modules/logistics/application/register-logistics-delivery-document";
import { PostgresLogisticsDeliveryDocumentRegistrar } from "../../src/modules/logistics/infrastructure/postgres-logistics-delivery-document-registrar";

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

describe("register logistics delivery document", () => {
  it("registers delivery document metadata idempotently with audit and without storage effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDeliveryDocumentDependencies(client);
      const useCase = new RegisterLogisticsDeliveryDocument(
        new PostgresLogisticsDeliveryDocumentRegistrar(pool)
      );
      const documentDate = new Date("2026-09-25T00:00:00.000Z");
      const file = {
        fileName: " termo-aceite.pdf ",
        contentType: " application/pdf ",
        sizeBytes: 2048,
        storageKey: " logistics/delivery/ENT-2026-0001/termo-aceite.pdf ",
        sha256: "b".repeat(64),
        uploadedByUserId: ` ${seed.uploadedByUserId} `
      };

      const result = await useCase.execute({
        commandId: " cmd-doc-entrega-001 ",
        deliveryId: ` ${seed.deliveryId} `,
        documentType: "TERMO_ACEITE",
        documentNumber: " TA-123 ",
        documentDate,
        issuerName: " Escola recebedora ",
        file,
        notes: " Documento assinado pela escola. ",
        actorUserId: seed.uploadedByUserId,
        teamContext: "GERENCIA_MATERIAIS",
        correlationId: " corr-doc-entrega-001 "
      });
      const replay = await useCase.execute({
        commandId: "cmd-doc-entrega-001",
        deliveryId: seed.deliveryId,
        documentType: "TERMO_ACEITE",
        documentNumber: "TA-123",
        documentDate,
        issuerName: "Escola recebedora",
        file: {
          ...file,
          fileName: "termo-aceite.pdf",
          contentType: "application/pdf",
          storageKey: "logistics/delivery/ENT-2026-0001/termo-aceite.pdf",
          uploadedByUserId: seed.uploadedByUserId
        },
        notes: "Documento assinado pela escola.",
        actorUserId: seed.uploadedByUserId,
        teamContext: "GERENCIA_MATERIAIS",
        correlationId: "corr-doc-entrega-001"
      });

      const conflict = await useCase.execute({
        commandId: "cmd-doc-entrega-001",
        deliveryId: seed.deliveryId,
        documentType: "TERMO_ACEITE",
        documentNumber: "TA-999",
        documentDate,
        issuerName: "Escola recebedora",
        file: {
          ...file,
          fileName: "termo-aceite.pdf",
          contentType: "application/pdf",
          storageKey: "logistics/delivery/ENT-2026-0001/termo-aceite.pdf",
          uploadedByUserId: seed.uploadedByUserId
        },
        notes: "Documento assinado pela escola."
      });
      const minimal = await useCase.execute({
        commandId: "cmd-doc-entrega-minimo-001",
        deliveryId: seed.deliveryId,
        documentType: "OUTRO"
      });

      expect(result).toEqual({
        ok: true,
        documentId: expect.any(String),
        deliveryId: seed.deliveryId,
        documentType: "TERMO_ACEITE"
      });
      expect(replay).toEqual(result);
      expect(conflict).toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        deliveryId: seed.deliveryId
      });
      expect(minimal).toEqual({
        ok: true,
        documentId: expect.any(String),
        deliveryId: seed.deliveryId,
        documentType: "OUTRO"
      });
      await expectDeliveryDocument(client, {
        documentId: result.ok ? result.documentId : "",
        deliveryId: seed.deliveryId,
        uploadedByUserId: seed.uploadedByUserId
      });
      await expectAuditEntry(client, result.ok ? result.documentId : "");
      await expectMinimalDeliveryDocument(
        client,
        minimal.ok ? minimal.documentId : "",
        seed.deliveryId
      );
      await expectCommandIdempotencyCount(client, "cmd-doc-entrega-001", 1);
      await expectDeliveryDocumentCount(client, 2);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejects invalid input and duplicate storage keys", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDeliveryDocumentDependencies(client);
      const useCase = new RegisterLogisticsDeliveryDocument(
        new PostgresLogisticsDeliveryDocumentRegistrar(pool)
      );
      const file = {
        fileName: "comprovante.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        storageKey: "logistics/delivery/ENT-2026-0001/comprovante.pdf",
        sha256: "c".repeat(64),
        uploadedByUserId: seed.uploadedByUserId
      };

      await expect(
        useCase.execute({
          commandId: "cmd-doc-invalid",
          deliveryId: seed.deliveryId,
          documentType: "OUTRO",
          file: { ...file, sha256: "ABC" }
        })
      ).resolves.toEqual({
        ok: false,
        reason: "INVALID_FILE_METADATA",
        deliveryId: seed.deliveryId
      });

      await expect(
        useCase.execute({
          commandId: "cmd-doc-invalid-date",
          deliveryId: seed.deliveryId,
          documentType: "OUTRO",
          documentDate: new Date("invalid")
        })
      ).resolves.toEqual({
        ok: false,
        reason: "INVALID_DOCUMENT_DATE",
        deliveryId: seed.deliveryId
      });

      const created = await useCase.execute({
        commandId: "cmd-doc-storage-1",
        deliveryId: seed.deliveryId,
        documentType: "COMPROVANTE_ENTREGA",
        file
      });
      const duplicateStorageKey = await useCase.execute({
        commandId: "cmd-doc-storage-2",
        deliveryId: seed.deliveryId,
        documentType: "COMPROVANTE_ENTREGA",
        file: { ...file, sha256: "d".repeat(64) }
      });
      const unknownDelivery = await useCase.execute({
        commandId: "cmd-doc-delivery-missing",
        deliveryId: randomUUID(),
        documentType: "OUTRO"
      });

      expect(created).toEqual({
        ok: true,
        documentId: expect.any(String),
        deliveryId: seed.deliveryId,
        documentType: "COMPROVANTE_ENTREGA"
      });
      expect(duplicateStorageKey).toEqual({
        ok: false,
        reason: "DUPLICATE_STORAGE_KEY",
        deliveryId: seed.deliveryId
      });
      expect(unknownDelivery).toEqual({
        ok: false,
        reason: "DELIVERY_NOT_FOUND",
        deliveryId: expect.any(String)
      });
      await expectDeliveryDocumentCount(client, 1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectDeliveryDocument(
  client: Client,
  input: {
    documentId: string;
    deliveryId: string;
    uploadedByUserId: string;
  }
): Promise<void> {
  const documents = await client.query<{
    delivery_id: string;
    document_type: string;
    document_number: string | null;
    issuer_name: string | null;
    file_name: string | null;
    content_type: string | null;
    size_bytes: string | null;
    storage_key: string | null;
    sha256: string | null;
    uploaded_by_user_id: string | null;
    notes: string | null;
  }>(
    `select "delivery_id",
            "document_type"::text,
            "document_number",
            "issuer_name",
            "file_name",
            "content_type",
            "size_bytes"::text,
            "storage_key",
            "sha256",
            "uploaded_by_user_id",
            "notes"
       from "logistics_delivery_document"
      where "id" = $1`,
    [input.documentId]
  );

  expect(documents.rows).toEqual([
    {
      delivery_id: input.deliveryId,
      document_type: "TERMO_ACEITE",
      document_number: "TA-123",
      issuer_name: "Escola recebedora",
      file_name: "termo-aceite.pdf",
      content_type: "application/pdf",
      size_bytes: "2048",
      storage_key: "logistics/delivery/ENT-2026-0001/termo-aceite.pdf",
      sha256: "b".repeat(64),
      uploaded_by_user_id: input.uploadedByUserId,
      notes: "Documento assinado pela escola."
    }
  ]);
}

async function expectMinimalDeliveryDocument(
  client: Client,
  documentId: string,
  deliveryId: string
): Promise<void> {
  const documents = await client.query<{
    delivery_id: string;
    document_type: string;
    document_number: string | null;
    storage_key: string | null;
  }>(
    `select "delivery_id",
            "document_type"::text,
            "document_number",
            "storage_key"
       from "logistics_delivery_document"
      where "id" = $1`,
    [documentId]
  );

  expect(documents.rows).toEqual([
    {
      delivery_id: deliveryId,
      document_type: "OUTRO",
      document_number: null,
      storage_key: null
    }
  ]);
}

async function expectAuditEntry(client: Client, documentId: string): Promise<void> {
  const audit = await client.query<{
    action: string;
    object_type: string;
    object_id: string;
    correlation_id: string;
  }>(
    `select "action", "object_type", "object_id", "correlation_id"
       from "audit_entry"
      where "object_type" = 'logistics_delivery_document'
        and "object_id" = $1`,
    [documentId]
  );

  expect(audit.rows).toEqual([
    {
      action: "logistics.register_delivery_document",
      object_type: "logistics_delivery_document",
      object_id: documentId,
      correlation_id: "corr-doc-entrega-001"
    }
  ]);
}
async function expectCommandIdempotencyCount(
  client: Client,
  idempotencyKey: string,
  expectedCount: number
): Promise<void> {
  const commands = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'logistics.register_delivery_document'
        and "idempotency_key" = $1`,
    [idempotencyKey]
  );

  expect(commands.rows).toEqual([{ count: expectedCount }]);
}

async function expectDeliveryDocumentCount(client: Client, expectedCount: number): Promise<void> {
  const documents = await client.query<{ count: number }>(
    `select count(*)::int as count from "logistics_delivery_document"`
  );

  expect(documents.rows).toEqual([{ count: expectedCount }]);
}

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
  const suffix = deliveryId.slice(0, 8).toUpperCase();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-DOC-CMD-${suffix}`, "GRE Documento Command"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [receivingEntityId, `ENT-DOC-CMD-${suffix}`, "Escola Documento Command", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, 3, current_timestamp)`,
    [
      materialRequestId,
      `SOL-DOC-CMD-${suffix}`,
      receivingEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao despachada para documento command"
    ]
  );
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      shipmentId,
      `EXP-DOC-CMD-${suffix}`,
      materialRequestId,
      receivingEntityId,
      "2026-09-24T20:00:00.000Z",
      "Envio para documento command"
    ]
  );
  await client.query(
    `insert into "logistics_delivery" (
      "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "updated_at"
    ) values ($1, $2, $3, 'TOTAL', $4, $5, current_timestamp)`,
    [
      deliveryId,
      `ENT-DOC-CMD-${suffix}`,
      shipmentId,
      "2026-09-25T13:00:00.000Z",
      "Entrega aceita para documento command"
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Documento Command"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [uploadedByUserId, personId, `documentos.command.${suffix.toLowerCase()}@gmap.local`]
  );

  return { deliveryId, uploadedByUserId };
}
