CREATE TABLE "logistics_shipment_item" (
  "id" UUID NOT NULL,
  "shipment_id" UUID NOT NULL,
  "line_number" INTEGER NOT NULL,
  "stock_position_id" UUID NOT NULL,
  "stock_separation_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "logistics_shipment_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "logistics_shipment_item_shipment_line_key" ON "logistics_shipment_item"("shipment_id", "line_number");
CREATE UNIQUE INDEX "logistics_shipment_item_shipment_separation_key" ON "logistics_shipment_item"("shipment_id", "stock_separation_id");
CREATE INDEX "logistics_shipment_item_shipment_id_idx" ON "logistics_shipment_item"("shipment_id");
CREATE INDEX "logistics_shipment_item_stock_position_id_idx" ON "logistics_shipment_item"("stock_position_id");
CREATE INDEX "logistics_shipment_item_stock_separation_id_idx" ON "logistics_shipment_item"("stock_separation_id");

ALTER TABLE "logistics_shipment_item"
  ADD CONSTRAINT "logistics_shipment_item_line_number_positive"
  CHECK ("line_number" > 0);

ALTER TABLE "logistics_shipment_item"
  ADD CONSTRAINT "logistics_shipment_item_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "logistics_shipment_item"
  ADD CONSTRAINT "logistics_shipment_item_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "logistics_shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "logistics_shipment_item"
  ADD CONSTRAINT "logistics_shipment_item_stock_position_id_fkey"
  FOREIGN KEY ("stock_position_id") REFERENCES "stock_position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "logistics_shipment_item"
  ADD CONSTRAINT "logistics_shipment_item_separation_position_fkey"
  FOREIGN KEY ("stock_separation_id", "stock_position_id") REFERENCES "stock_separation"("id", "stock_position_id") ON DELETE RESTRICT ON UPDATE CASCADE;