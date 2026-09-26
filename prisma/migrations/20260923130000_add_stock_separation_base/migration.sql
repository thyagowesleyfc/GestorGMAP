CREATE TYPE "StockSeparationStatus" AS ENUM ('EM_SEPARACAO');

CREATE UNIQUE INDEX "stock_reservation_id_position_id_key" ON "stock_reservation"("id", "stock_position_id");

CREATE TABLE "stock_separation" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "stock_position_id" UUID NOT NULL,
  "stock_reservation_id" UUID NOT NULL,
  "status" "StockSeparationStatus" NOT NULL DEFAULT 'EM_SEPARACAO',
  "quantity" INTEGER NOT NULL,
  "separated_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_separation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_separation_code_key" ON "stock_separation"("code");
CREATE INDEX "stock_separation_stock_position_id_idx" ON "stock_separation"("stock_position_id");
CREATE INDEX "stock_separation_position_status_idx" ON "stock_separation"("stock_position_id", "status");
CREATE INDEX "stock_separation_stock_reservation_id_idx" ON "stock_separation"("stock_reservation_id");
CREATE INDEX "stock_separation_reservation_status_idx" ON "stock_separation"("stock_reservation_id", "status");
CREATE INDEX "stock_separation_status_idx" ON "stock_separation"("status");
CREATE INDEX "stock_separation_separated_at_idx" ON "stock_separation"("separated_at");

ALTER TABLE "stock_separation"
  ADD CONSTRAINT "stock_separation_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "stock_separation"
  ADD CONSTRAINT "stock_separation_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "stock_separation"
  ADD CONSTRAINT "stock_separation_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "stock_separation"
  ADD CONSTRAINT "stock_separation_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "stock_separation"
  ADD CONSTRAINT "stock_separation_stock_position_id_fkey"
  FOREIGN KEY ("stock_position_id") REFERENCES "stock_position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_separation"
  ADD CONSTRAINT "stock_separation_reservation_position_fkey"
  FOREIGN KEY ("stock_reservation_id", "stock_position_id") REFERENCES "stock_reservation"("id", "stock_position_id") ON DELETE RESTRICT ON UPDATE CASCADE;