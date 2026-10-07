CREATE TYPE "LogisticsDeliveryDocumentType" AS ENUM ('COMPROVANTE_ENTREGA', 'TERMO_ACEITE', 'OUTRO');
CREATE TYPE "LogisticsDeliveryDocumentOrigin" AS ENUM ('EXTERNO');

CREATE TABLE "logistics_delivery_document" (
  "id" UUID NOT NULL,
  "delivery_id" UUID NOT NULL,
  "document_type" "LogisticsDeliveryDocumentType" NOT NULL,
  "origin" "LogisticsDeliveryDocumentOrigin" NOT NULL DEFAULT 'EXTERNO',
  "document_number" VARCHAR(80),
  "document_date" DATE,
  "issuer_name" VARCHAR(180),
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
  CONSTRAINT "logistics_delivery_document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "logistics_delivery_document_storage_key_key" ON "logistics_delivery_document"("storage_key");
CREATE INDEX "logistics_delivery_document_delivery_id_idx" ON "logistics_delivery_document"("delivery_id");
CREATE INDEX "logistics_delivery_document_document_type_idx" ON "logistics_delivery_document"("document_type");
CREATE INDEX "logistics_delivery_document_document_date_idx" ON "logistics_delivery_document"("document_date");
CREATE INDEX "logistics_delivery_document_uploaded_by_user_id_idx" ON "logistics_delivery_document"("uploaded_by_user_id");
CREATE INDEX "logistics_delivery_document_sha256_idx" ON "logistics_delivery_document"("sha256");

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_number_not_blank"
  CHECK ("document_number" IS NULL OR length(btrim("document_number")) > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_issuer_name_not_blank"
  CHECK ("issuer_name" IS NULL OR length(btrim("issuer_name")) > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_file_name_not_blank"
  CHECK ("file_name" IS NULL OR length(btrim("file_name")) > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_content_type_not_blank"
  CHECK ("content_type" IS NULL OR length(btrim("content_type")) > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_size_positive"
  CHECK ("size_bytes" IS NULL OR "size_bytes" > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_storage_key_not_blank"
  CHECK ("storage_key" IS NULL OR length(btrim("storage_key")) > 0);

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_sha256_format"
  CHECK ("sha256" IS NULL OR ("sha256" = lower("sha256") AND "sha256" ~ '^[0-9a-f]{64}$'));

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_file_metadata_complete"
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

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_delivery_id_fkey"
  FOREIGN KEY ("delivery_id") REFERENCES "logistics_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "logistics_delivery_document"
  ADD CONSTRAINT "logistics_delivery_document_uploaded_by_user_id_fkey"
  FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;