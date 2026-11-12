ALTER TYPE "ContractBalanceMovementType" ADD VALUE 'GLOSA_OS';

ALTER TABLE "maintenance_service_order_service"
  ADD COLUMN "glosed_quantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "glosed_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_glosed_quantity_valid"
  CHECK ("glosed_quantity" >= 0 AND "glosed_quantity" <= "quantity");

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_glosed_amount_consistent"
  CHECK ("glosed_amount" = ("glosed_quantity"::numeric * "unit_price"));

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_glosa_os_origin_valid"
  CHECK (
    "type"::text <> 'GLOSA_OS'
    OR (
      "maintenance_service_order_service_id" IS NOT NULL
      AND "quantity_delta" > 0
      AND "amount_delta" > 0
    )
  );

