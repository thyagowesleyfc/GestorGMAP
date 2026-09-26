CREATE TYPE "StockReservationStatus" AS ENUM ('ATIVA');

CREATE TABLE "stock_reservation" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "stock_position_id" UUID NOT NULL,
  "status" "StockReservationStatus" NOT NULL DEFAULT 'ATIVA',
  "quantity" INTEGER NOT NULL,
  "reserved_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_reservation_code_key" ON "stock_reservation"("code");
CREATE INDEX "stock_reservation_stock_position_id_idx" ON "stock_reservation"("stock_position_id");
CREATE INDEX "stock_reservation_position_status_idx" ON "stock_reservation"("stock_position_id", "status");
CREATE INDEX "stock_reservation_status_idx" ON "stock_reservation"("status");
CREATE INDEX "stock_reservation_reserved_at_idx" ON "stock_reservation"("reserved_at");

ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_stock_position_id_fkey"
  FOREIGN KEY ("stock_position_id") REFERENCES "stock_position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;