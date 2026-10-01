CREATE TABLE "material_request_item" (
  "id" UUID NOT NULL,
  "material_request_id" UUID NOT NULL,
  "line_number" INTEGER NOT NULL,
  "material_singular_id" UUID,
  "material_configuration_id" UUID,
  "requested_quantity" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "material_request_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_request_item_request_line_key" ON "material_request_item"("material_request_id", "line_number");
CREATE INDEX "material_request_item_material_request_id_idx" ON "material_request_item"("material_request_id");
CREATE INDEX "material_request_item_material_singular_id_idx" ON "material_request_item"("material_singular_id");
CREATE INDEX "material_request_item_material_configuration_id_idx" ON "material_request_item"("material_configuration_id");

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_line_number_positive"
  CHECK ("line_number" > 0);

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_requested_quantity_positive"
  CHECK ("requested_quantity" > 0);

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_catalog_reference_xor"
  CHECK (
    ("material_singular_id" IS NOT NULL AND "material_configuration_id" IS NULL)
    OR ("material_singular_id" IS NULL AND "material_configuration_id" IS NOT NULL)
  );

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_material_request_id_fkey"
  FOREIGN KEY ("material_request_id") REFERENCES "material_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_material_singular_id_fkey"
  FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_material_configuration_id_fkey"
  FOREIGN KEY ("material_configuration_id") REFERENCES "material_configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;