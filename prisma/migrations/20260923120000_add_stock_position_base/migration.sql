CREATE TABLE "stock_position" (
  "id" UUID NOT NULL,
  "stock_entity_id" UUID NOT NULL,
  "material_singular_id" UUID,
  "material_configuration_id" UUID,
  "origin_type" "ReceivingEntryItemOriginType" NOT NULL,
  "physical_quantity" INTEGER NOT NULL DEFAULT 0,
  "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
  "separating_quantity" INTEGER NOT NULL DEFAULT 0,
  "available_quantity" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_position_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_position_entity_singular_origin_key"
  ON "stock_position"("stock_entity_id", "material_singular_id", "origin_type")
  WHERE "material_singular_id" IS NOT NULL;

CREATE UNIQUE INDEX "stock_position_entity_configuration_origin_key"
  ON "stock_position"("stock_entity_id", "material_configuration_id", "origin_type")
  WHERE "material_configuration_id" IS NOT NULL;

CREATE INDEX "stock_position_stock_entity_id_idx" ON "stock_position"("stock_entity_id");
CREATE INDEX "stock_position_material_singular_id_idx" ON "stock_position"("material_singular_id");
CREATE INDEX "stock_position_material_configuration_id_idx" ON "stock_position"("material_configuration_id");
CREATE INDEX "stock_position_origin_type_idx" ON "stock_position"("origin_type");

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_catalog_reference_xor"
  CHECK (
    ("material_singular_id" IS NOT NULL AND "material_configuration_id" IS NULL)
    OR ("material_singular_id" IS NULL AND "material_configuration_id" IS NOT NULL)
  );

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_quantities_non_negative"
  CHECK (
    "physical_quantity" >= 0
    AND "reserved_quantity" >= 0
    AND "separating_quantity" >= 0
    AND "available_quantity" >= 0
  );

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_available_consistent"
  CHECK ("available_quantity" = "physical_quantity" - "reserved_quantity" - "separating_quantity");

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_stock_entity_id_fkey"
  FOREIGN KEY ("stock_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_material_singular_id_fkey"
  FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_position"
  ADD CONSTRAINT "stock_position_material_configuration_id_fkey"
  FOREIGN KEY ("material_configuration_id") REFERENCES "material_configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;