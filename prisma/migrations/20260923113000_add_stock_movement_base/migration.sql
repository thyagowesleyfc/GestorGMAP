CREATE TYPE "StockMovementType" AS ENUM ('ENTRADA_RECEBIMENTO');

CREATE UNIQUE INDEX "receiving_entry_item_regularization_identity_key"
  ON "receiving_entry_item_regularization"("id", "receiving_entry_item_id", "origin_type");

CREATE TABLE "stock_movement" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "movement_type" "StockMovementType" NOT NULL,
  "receiving_entry_item_regularization_id" UUID NOT NULL,
  "receiving_entry_item_id" UUID NOT NULL,
  "origin_type" "ReceivingEntryItemOriginType" NOT NULL,
  "quantity_delta" INTEGER NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_movement_code_key" ON "stock_movement"("code");
CREATE UNIQUE INDEX "stock_movement_receiving_regularization_type_key" ON "stock_movement"("receiving_entry_item_regularization_id", "movement_type");
CREATE INDEX "stock_movement_movement_type_idx" ON "stock_movement"("movement_type");
CREATE INDEX "stock_movement_regularization_id_idx" ON "stock_movement"("receiving_entry_item_regularization_id");
CREATE INDEX "stock_movement_receiving_entry_item_id_idx" ON "stock_movement"("receiving_entry_item_id");
CREATE INDEX "stock_movement_origin_type_idx" ON "stock_movement"("origin_type");
CREATE INDEX "stock_movement_occurred_at_idx" ON "stock_movement"("occurred_at");

ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_quantity_delta_non_zero"
  CHECK ("quantity_delta" <> 0);

ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_receipt_entry_positive"
  CHECK ("movement_type" <> 'ENTRADA_RECEBIMENTO' OR "quantity_delta" > 0);

ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_receiving_entry_item_id_fkey"
  FOREIGN KEY ("receiving_entry_item_id") REFERENCES "receiving_entry_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_regularization_identity_fkey"
  FOREIGN KEY ("receiving_entry_item_regularization_id", "receiving_entry_item_id", "origin_type")
  REFERENCES "receiving_entry_item_regularization"("id", "receiving_entry_item_id", "origin_type") ON DELETE RESTRICT ON UPDATE CASCADE;