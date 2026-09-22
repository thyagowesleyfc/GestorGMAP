CREATE TYPE "SupplyOrderStatus" AS ENUM ('EMITIDA');

CREATE UNIQUE INDEX "contract_item_id_contract_id_key" ON "contract_item"("id", "contract_id");

CREATE TABLE "supply_order" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "contract_id" UUID NOT NULL,
  "status" "SupplyOrderStatus" NOT NULL DEFAULT 'EMITIDA',
  "issued_at" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supply_order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supply_order_item" (
  "id" UUID NOT NULL,
  "supply_order_id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "contract_item_id" UUID NOT NULL,
  "line_number" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price" DECIMAL(14,2) NOT NULL,
  "total_amount" DECIMAL(14,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supply_order_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supply_order_code_key" ON "supply_order"("code");
CREATE UNIQUE INDEX "supply_order_id_contract_id_key" ON "supply_order"("id", "contract_id");
CREATE INDEX "supply_order_contract_id_idx" ON "supply_order"("contract_id");
CREATE INDEX "supply_order_status_idx" ON "supply_order"("status");
CREATE UNIQUE INDEX "supply_order_item_order_line_key" ON "supply_order_item"("supply_order_id", "line_number");
CREATE INDEX "supply_order_item_contract_id_idx" ON "supply_order_item"("contract_id");
CREATE INDEX "supply_order_item_contract_item_id_idx" ON "supply_order_item"("contract_item_id");

ALTER TABLE "supply_order"
  ADD CONSTRAINT "supply_order_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "supply_order"
  ADD CONSTRAINT "supply_order_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "supply_order_item"
  ADD CONSTRAINT "supply_order_item_line_number_positive"
  CHECK ("line_number" > 0);

ALTER TABLE "supply_order_item"
  ADD CONSTRAINT "supply_order_item_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "supply_order_item"
  ADD CONSTRAINT "supply_order_item_unit_price_non_negative"
  CHECK ("unit_price" >= 0);

ALTER TABLE "supply_order_item"
  ADD CONSTRAINT "supply_order_item_total_amount_consistent"
  CHECK ("total_amount" = "quantity" * "unit_price");

ALTER TABLE "supply_order"
  ADD CONSTRAINT "supply_order_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supply_order_item"
  ADD CONSTRAINT "supply_order_item_supply_order_contract_fkey"
  FOREIGN KEY ("supply_order_id", "contract_id") REFERENCES "supply_order"("id", "contract_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supply_order_item"
  ADD CONSTRAINT "supply_order_item_contract_item_contract_fkey"
  FOREIGN KEY ("contract_item_id", "contract_id") REFERENCES "contract_item"("id", "contract_id") ON DELETE RESTRICT ON UPDATE CASCADE;