CREATE TYPE "ReceivingEntryStatus" AS ENUM ('REGISTRADA');
CREATE TYPE "ReceivingEntryItemOriginType" AS ENUM ('CONTRATUAL', 'INDENIZATORIO', 'PENDENTE');

CREATE TABLE "receiving_entry" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "receiving_entity_id" UUID NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL,
  "status" "ReceivingEntryStatus" NOT NULL DEFAULT 'REGISTRADA',
  "notes" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receiving_entry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "receiving_entry_item" (
  "id" UUID NOT NULL,
  "receiving_entry_id" UUID NOT NULL,
  "line_number" INTEGER NOT NULL,
  "material_singular_id" UUID,
  "material_configuration_id" UUID,
  "origin_type" "ReceivingEntryItemOriginType" NOT NULL DEFAULT 'PENDENTE',
  "quantity" INTEGER NOT NULL,
  "notes" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receiving_entry_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_entry_code_key" ON "receiving_entry"("code");
CREATE INDEX "receiving_entry_receiving_entity_id_idx" ON "receiving_entry"("receiving_entity_id");
CREATE INDEX "receiving_entry_received_at_idx" ON "receiving_entry"("received_at");
CREATE INDEX "receiving_entry_status_idx" ON "receiving_entry"("status");
CREATE UNIQUE INDEX "receiving_entry_item_entry_line_key" ON "receiving_entry_item"("receiving_entry_id", "line_number");
CREATE INDEX "receiving_entry_item_receiving_entry_id_idx" ON "receiving_entry_item"("receiving_entry_id");
CREATE INDEX "receiving_entry_item_material_singular_id_idx" ON "receiving_entry_item"("material_singular_id");
CREATE INDEX "receiving_entry_item_material_configuration_id_idx" ON "receiving_entry_item"("material_configuration_id");
CREATE INDEX "receiving_entry_item_origin_type_idx" ON "receiving_entry_item"("origin_type");

ALTER TABLE "receiving_entry"
  ADD CONSTRAINT "receiving_entry_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "receiving_entry"
  ADD CONSTRAINT "receiving_entry_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "receiving_entry_item"
  ADD CONSTRAINT "receiving_entry_item_line_number_positive"
  CHECK ("line_number" > 0);

ALTER TABLE "receiving_entry_item"
  ADD CONSTRAINT "receiving_entry_item_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "receiving_entry_item"
  ADD CONSTRAINT "receiving_entry_item_catalog_reference_xor"
  CHECK (
    ("material_singular_id" IS NOT NULL AND "material_configuration_id" IS NULL)
    OR ("material_singular_id" IS NULL AND "material_configuration_id" IS NOT NULL)
  );

ALTER TABLE "receiving_entry"
  ADD CONSTRAINT "receiving_entry_receiving_entity_id_fkey"
  FOREIGN KEY ("receiving_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item"
  ADD CONSTRAINT "receiving_entry_item_receiving_entry_id_fkey"
  FOREIGN KEY ("receiving_entry_id") REFERENCES "receiving_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item"
  ADD CONSTRAINT "receiving_entry_item_material_singular_id_fkey"
  FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item"
  ADD CONSTRAINT "receiving_entry_item_material_configuration_id_fkey"
  FOREIGN KEY ("material_configuration_id") REFERENCES "material_configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;