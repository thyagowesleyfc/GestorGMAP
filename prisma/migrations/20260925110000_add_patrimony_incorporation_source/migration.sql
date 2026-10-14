ALTER TABLE "patrimony"
  ADD COLUMN "source_delivery_id" UUID,
  ADD COLUMN "source_shipment_item_id" UUID,
  ADD COLUMN "incorporated_at" TIMESTAMP(3);

CREATE INDEX "patrimony_source_delivery_id_idx" ON "patrimony"("source_delivery_id");
CREATE INDEX "patrimony_source_shipment_item_id_idx" ON "patrimony"("source_shipment_item_id");
CREATE INDEX "patrimony_incorporated_at_idx" ON "patrimony"("incorporated_at");

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_incorporation_source_consistency"
  CHECK (
    (
      "source_delivery_id" IS NULL
      AND "source_shipment_item_id" IS NULL
      AND "incorporated_at" IS NULL
    )
    OR (
      "source_delivery_id" IS NOT NULL
      AND "source_shipment_item_id" IS NOT NULL
      AND "incorporated_at" IS NOT NULL
    )
  );

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_source_delivery_id_fkey"
  FOREIGN KEY ("source_delivery_id") REFERENCES "logistics_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_source_shipment_item_id_fkey"
  FOREIGN KEY ("source_shipment_item_id") REFERENCES "logistics_shipment_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
