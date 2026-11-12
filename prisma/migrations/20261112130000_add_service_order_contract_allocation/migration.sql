ALTER TYPE "ContractBalanceMovementType" ADD VALUE 'COMPROMETIMENTO_OS';

ALTER TABLE "maintenance_service_order_service"
  ADD COLUMN "contract_item_id" UUID NOT NULL,
  ADD COLUMN "quantity" INTEGER NOT NULL,
  ADD COLUMN "unit_price" DECIMAL(14, 2) NOT NULL,
  ADD COLUMN "total_amount" DECIMAL(14, 2) NOT NULL;

CREATE INDEX "maintenance_service_order_service_contract_item_id_idx"
  ON "maintenance_service_order_service"("contract_item_id");

ALTER TABLE "contract_balance_movement"
  ADD COLUMN "maintenance_service_order_service_id" UUID;

CREATE INDEX "contract_balance_movement_service_order_service_id_idx"
  ON "contract_balance_movement"("maintenance_service_order_service_id");

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_unit_price_non_negative"
  CHECK ("unit_price" >= 0);

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_total_amount_consistent"
  CHECK ("total_amount" = ("quantity"::numeric * "unit_price"));

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_contract_item_id_fkey"
  FOREIGN KEY ("contract_item_id") REFERENCES "contract_item"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_service_order_service_id_fkey"
  FOREIGN KEY ("maintenance_service_order_service_id")
  REFERENCES "maintenance_service_order_service"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
