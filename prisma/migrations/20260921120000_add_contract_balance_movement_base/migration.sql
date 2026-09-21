CREATE TYPE "ContractBalanceMovementType" AS ENUM (
  'CONTRATACAO',
  'ADITIVO',
  'APOSTILAMENTO',
  'AJUSTE'
);

CREATE TABLE "contract_balance_movement" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "contract_item_id" UUID NOT NULL,
  "contract_change_id" UUID,
  "type" "ContractBalanceMovementType" NOT NULL,
  "quantity_delta" INTEGER NOT NULL,
  "amount_delta" DECIMAL(14,2) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contract_balance_movement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contract_balance_movement_code_key" ON "contract_balance_movement"("code");
CREATE INDEX "contract_balance_movement_contract_item_id_idx" ON "contract_balance_movement"("contract_item_id");
CREATE INDEX "contract_balance_movement_contract_change_id_idx" ON "contract_balance_movement"("contract_change_id");
CREATE INDEX "contract_balance_movement_type_idx" ON "contract_balance_movement"("type");
CREATE INDEX "contract_balance_movement_item_time_idx" ON "contract_balance_movement"("contract_item_id", "occurred_at");

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_delta_non_zero"
  CHECK ("quantity_delta" <> 0 OR "amount_delta" <> 0);

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_contract_item_id_fkey"
  FOREIGN KEY ("contract_item_id") REFERENCES "contract_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contract_balance_movement"
  ADD CONSTRAINT "contract_balance_movement_contract_change_id_fkey"
  FOREIGN KEY ("contract_change_id") REFERENCES "contract_change"("id") ON DELETE RESTRICT ON UPDATE CASCADE;