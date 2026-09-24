CREATE TYPE "ReceivingEntryDocumentType" AS ENUM ('NOTA_FISCAL', 'DOCUMENTO_ENTREGA', 'OUTRO');
CREATE TYPE "ReceivingEntryDocumentOrigin" AS ENUM ('EXTERNO');

CREATE TABLE "receiving_entry_document" (
  "id" UUID NOT NULL,
  "receiving_entry_id" UUID NOT NULL,
  "document_type" "ReceivingEntryDocumentType" NOT NULL,
  "origin" "ReceivingEntryDocumentOrigin" NOT NULL DEFAULT 'EXTERNO',
  "document_number" VARCHAR(80),
  "document_series" VARCHAR(20),
  "document_date" DATE,
  "issuer_name" VARCHAR(180),
  "invoice_access_key" CHAR(44),
  "file_name" VARCHAR(255),
  "content_type" VARCHAR(120),
  "size_bytes" BIGINT,
  "storage_key" TEXT,
  "sha256" CHAR(64),
  "uploaded_by_user_id" UUID,
  "notes" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receiving_entry_document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_entry_document_storage_key_key" ON "receiving_entry_document"("storage_key");
CREATE INDEX "receiving_entry_document_receiving_entry_id_idx" ON "receiving_entry_document"("receiving_entry_id");
CREATE INDEX "receiving_entry_document_document_type_idx" ON "receiving_entry_document"("document_type");
CREATE INDEX "receiving_entry_document_document_date_idx" ON "receiving_entry_document"("document_date");
CREATE INDEX "receiving_entry_document_invoice_access_key_idx" ON "receiving_entry_document"("invoice_access_key");
CREATE INDEX "receiving_entry_document_uploaded_by_user_id_idx" ON "receiving_entry_document"("uploaded_by_user_id");
CREATE INDEX "receiving_entry_document_sha256_idx" ON "receiving_entry_document"("sha256");

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_number_not_blank"
  CHECK ("document_number" IS NULL OR length(btrim("document_number")) > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_series_not_blank"
  CHECK ("document_series" IS NULL OR length(btrim("document_series")) > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_issuer_name_not_blank"
  CHECK ("issuer_name" IS NULL OR length(btrim("issuer_name")) > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_file_name_not_blank"
  CHECK ("file_name" IS NULL OR length(btrim("file_name")) > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_content_type_not_blank"
  CHECK ("content_type" IS NULL OR length(btrim("content_type")) > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_size_positive"
  CHECK ("size_bytes" IS NULL OR "size_bytes" > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_storage_key_not_blank"
  CHECK ("storage_key" IS NULL OR length(btrim("storage_key")) > 0);

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_sha256_format"
  CHECK ("sha256" IS NULL OR ("sha256" = lower("sha256") AND "sha256" ~ '^[0-9a-f]{64}$'));

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_invoice_access_key_format"
  CHECK ("invoice_access_key" IS NULL OR "invoice_access_key" ~ '^[0-9]{44}$');

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_file_metadata_complete"
  CHECK (
    (
      "file_name" IS NULL
      AND "content_type" IS NULL
      AND "size_bytes" IS NULL
      AND "storage_key" IS NULL
      AND "sha256" IS NULL
      AND "uploaded_by_user_id" IS NULL
    )
    OR (
      "file_name" IS NOT NULL
      AND "content_type" IS NOT NULL
      AND "size_bytes" IS NOT NULL
      AND "storage_key" IS NOT NULL
      AND "sha256" IS NOT NULL
      AND "uploaded_by_user_id" IS NOT NULL
    )
  );

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_receiving_entry_id_fkey"
  FOREIGN KEY ("receiving_entry_id") REFERENCES "receiving_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_document"
  ADD CONSTRAINT "receiving_entry_document_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;