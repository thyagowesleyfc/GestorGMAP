CREATE TYPE "LogisticsDeliveryAcceptanceStatus" AS ENUM ('TOTAL', 'PARCIAL', 'RECUSADO');

CREATE TABLE "logistics_delivery" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "shipment_id" UUID NOT NULL,
  "acceptance_status" "LogisticsDeliveryAcceptanceStatus" NOT NULL,
  "delivered_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "logistics_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "logistics_delivery_code_key" ON "logistics_delivery"("code");
CREATE UNIQUE INDEX "logistics_delivery_shipment_id_key" ON "logistics_delivery"("shipment_id");
CREATE INDEX "logistics_delivery_shipment_id_idx" ON "logistics_delivery"("shipment_id");
CREATE INDEX "logistics_delivery_acceptance_status_idx" ON "logistics_delivery"("acceptance_status");
CREATE INDEX "logistics_delivery_delivered_at_idx" ON "logistics_delivery"("delivered_at");

ALTER TABLE "logistics_delivery"
  ADD CONSTRAINT "logistics_delivery_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "logistics_delivery"
  ADD CONSTRAINT "logistics_delivery_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "logistics_delivery"
  ADD CONSTRAINT "logistics_delivery_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "logistics_delivery"
  ADD CONSTRAINT "logistics_delivery_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "logistics_shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;