CREATE TYPE "LogisticsShipmentStatus" AS ENUM ('REGISTRADA');

CREATE TABLE "logistics_shipment" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "material_request_id" UUID NOT NULL,
  "receiving_entity_id" UUID NOT NULL,
  "status" "LogisticsShipmentStatus" NOT NULL DEFAULT 'REGISTRADA',
  "shipped_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "logistics_shipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "logistics_shipment_code_key" ON "logistics_shipment"("code");
CREATE INDEX "logistics_shipment_material_request_id_idx" ON "logistics_shipment"("material_request_id");
CREATE INDEX "logistics_shipment_receiving_entity_id_idx" ON "logistics_shipment"("receiving_entity_id");
CREATE INDEX "logistics_shipment_status_idx" ON "logistics_shipment"("status");
CREATE INDEX "logistics_shipment_shipped_at_idx" ON "logistics_shipment"("shipped_at");

ALTER TABLE "logistics_shipment"
  ADD CONSTRAINT "logistics_shipment_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "logistics_shipment"
  ADD CONSTRAINT "logistics_shipment_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "logistics_shipment"
  ADD CONSTRAINT "logistics_shipment_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "logistics_shipment"
  ADD CONSTRAINT "logistics_shipment_material_request_id_fkey"
  FOREIGN KEY ("material_request_id") REFERENCES "material_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "logistics_shipment"
  ADD CONSTRAINT "logistics_shipment_receiving_entity_id_fkey"
  FOREIGN KEY ("receiving_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;