CREATE TABLE "contract_balance_position" (
  "id" UUID NOT NULL,
  "contract_item_id" UUID NOT NULL,
  "total_quantity" INTEGER NOT NULL,
  "committed_quantity" INTEGER NOT NULL DEFAULT 0,
  "available_quantity" INTEGER NOT NULL,
  "total_amount" DECIMAL(14,2) NOT NULL,
  "committed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "available_amount" DECIMAL(14,2) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contract_balance_position_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contract_balance_position_contract_item_id_key" ON "contract_balance_position"("contract_item_id");
ALTER TABLE "contract_balance_position"
  ADD CONSTRAINT "contract_balance_position_quantities_non_negative"
  CHECK ("total_quantity" >= 0 AND "committed_quantity" >= 0 AND "available_quantity" >= 0);

ALTER TABLE "contract_balance_position"
  ADD CONSTRAINT "contract_balance_position_amounts_non_negative"
  CHECK ("total_amount" >= 0 AND "committed_amount" >= 0 AND "available_amount" >= 0);

ALTER TABLE "contract_balance_position"
  ADD CONSTRAINT "contract_balance_position_quantity_balance"
  CHECK ("total_quantity" = "committed_quantity" + "available_quantity");

ALTER TABLE "contract_balance_position"
  ADD CONSTRAINT "contract_balance_position_amount_balance"
  CHECK ("total_amount" = "committed_amount" + "available_amount");

ALTER TABLE "contract_balance_position"
  ADD CONSTRAINT "contract_balance_position_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "contract_balance_position"
  ADD CONSTRAINT "contract_balance_position_contract_item_id_fkey"
  FOREIGN KEY ("contract_item_id") REFERENCES "contract_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;