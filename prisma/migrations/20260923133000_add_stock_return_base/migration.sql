CREATE TYPE "StockReturnStatus" AS ENUM ('REGISTRADA');

CREATE UNIQUE INDEX "stock_separation_id_position_id_key" ON "stock_separation"("id", "stock_position_id");

CREATE TABLE "stock_return" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "stock_position_id" UUID NOT NULL,
  "stock_separation_id" UUID NOT NULL,
  "status" "StockReturnStatus" NOT NULL DEFAULT 'REGISTRADA',
  "quantity" INTEGER NOT NULL,
  "returned_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_return_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_return_code_key" ON "stock_return"("code");
CREATE INDEX "stock_return_stock_position_id_idx" ON "stock_return"("stock_position_id");
CREATE INDEX "stock_return_position_status_idx" ON "stock_return"("stock_position_id", "status");
CREATE INDEX "stock_return_stock_separation_id_idx" ON "stock_return"("stock_separation_id");
CREATE INDEX "stock_return_separation_status_idx" ON "stock_return"("stock_separation_id", "status");
CREATE INDEX "stock_return_status_idx" ON "stock_return"("status");
CREATE INDEX "stock_return_returned_at_idx" ON "stock_return"("returned_at");

ALTER TABLE "stock_return"
  ADD CONSTRAINT "stock_return_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "stock_return"
  ADD CONSTRAINT "stock_return_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "stock_return"
  ADD CONSTRAINT "stock_return_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "stock_return"
  ADD CONSTRAINT "stock_return_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "stock_return"
  ADD CONSTRAINT "stock_return_stock_position_id_fkey"
  FOREIGN KEY ("stock_position_id") REFERENCES "stock_position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_return"
  ADD CONSTRAINT "stock_return_separation_position_fkey"
  FOREIGN KEY ("stock_separation_id", "stock_position_id") REFERENCES "stock_separation"("id", "stock_position_id") ON DELETE RESTRICT ON UPDATE CASCADE;