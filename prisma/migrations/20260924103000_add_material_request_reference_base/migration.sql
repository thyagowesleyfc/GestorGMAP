CREATE TYPE "MaterialRequestReferenceSystem" AS ENUM ('SEI', 'REDMINE');

CREATE TABLE "material_request_reference" (
  "id" UUID NOT NULL,
  "material_request_id" UUID NOT NULL,
  "system" "MaterialRequestReferenceSystem" NOT NULL,
  "reference_type" VARCHAR(80) NOT NULL,
  "identifier" VARCHAR(160) NOT NULL,
  "url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "material_request_reference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_request_reference_system_identifier_key" ON "material_request_reference"("system", "identifier");
CREATE UNIQUE INDEX "material_request_reference_request_system_identifier_key" ON "material_request_reference"("material_request_id", "system", "identifier");
CREATE INDEX "material_request_reference_material_request_id_idx" ON "material_request_reference"("material_request_id");
CREATE INDEX "material_request_reference_system_idx" ON "material_request_reference"("system");
CREATE INDEX "material_request_reference_reference_type_idx" ON "material_request_reference"("reference_type");

ALTER TABLE "material_request_reference"
  ADD CONSTRAINT "material_request_reference_type_not_blank"
  CHECK (length(btrim("reference_type")) > 0);

ALTER TABLE "material_request_reference"
  ADD CONSTRAINT "material_request_reference_identifier_not_blank"
  CHECK (length(btrim("identifier")) > 0);

ALTER TABLE "material_request_reference"
  ADD CONSTRAINT "material_request_reference_url_not_blank"
  CHECK ("url" IS NULL OR length(btrim("url")) > 0);

ALTER TABLE "material_request_reference"
  ADD CONSTRAINT "material_request_reference_material_request_id_fkey"
  FOREIGN KEY ("material_request_id") REFERENCES "material_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;