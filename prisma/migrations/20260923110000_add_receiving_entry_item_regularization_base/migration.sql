CREATE UNIQUE INDEX "supply_order_item_identity_key" ON "supply_order_item"("id", "supply_order_id", "contract_id", "contract_item_id");

CREATE TABLE "receiving_entry_item_regularization" (
  "id" UUID NOT NULL,
  "receiving_entry_item_id" UUID NOT NULL,
  "origin_type" "ReceivingEntryItemOriginType" NOT NULL,
  "regularized_at" TIMESTAMP(3) NOT NULL,
  "contract_id" UUID,
  "contract_item_id" UUID,
  "supply_order_id" UUID,
  "supply_order_item_id" UUID,
  "regularized_by_user_id" UUID,
  "notes" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receiving_entry_item_regularization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_entry_item_regularization_item_key" ON "receiving_entry_item_regularization"("receiving_entry_item_id");
CREATE INDEX "receiving_entry_item_regularization_item_id_idx" ON "receiving_entry_item_regularization"("receiving_entry_item_id");
CREATE INDEX "receiving_entry_item_regularization_origin_type_idx" ON "receiving_entry_item_regularization"("origin_type");
CREATE INDEX "receiving_entry_item_regularization_regularized_at_idx" ON "receiving_entry_item_regularization"("regularized_at");
CREATE INDEX "receiving_entry_item_regularization_contract_id_idx" ON "receiving_entry_item_regularization"("contract_id");
CREATE INDEX "receiving_entry_item_regularization_contract_item_id_idx" ON "receiving_entry_item_regularization"("contract_item_id");
CREATE INDEX "receiving_entry_item_regularization_supply_order_id_idx" ON "receiving_entry_item_regularization"("supply_order_id");
CREATE INDEX "receiving_entry_item_regularization_supply_order_item_id_idx" ON "receiving_entry_item_regularization"("supply_order_item_id");
CREATE INDEX "receiving_entry_item_regularization_user_id_idx" ON "receiving_entry_item_regularization"("regularized_by_user_id");

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_notes_not_blank"
  CHECK ("notes" IS NULL OR length(btrim("notes")) > 0);

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_origin_refs"
  CHECK (
    (
      "origin_type" = 'CONTRATUAL'
      AND "contract_id" IS NOT NULL
      AND "contract_item_id" IS NOT NULL
      AND "supply_order_id" IS NOT NULL
      AND "supply_order_item_id" IS NOT NULL
    )
    OR (
      "origin_type" <> 'CONTRATUAL'
      AND "contract_id" IS NULL
      AND "contract_item_id" IS NULL
      AND "supply_order_id" IS NULL
      AND "supply_order_item_id" IS NULL
    )
  );

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_supply_order_pair"
  CHECK (
    ("supply_order_id" IS NULL AND "supply_order_item_id" IS NULL)
    OR ("supply_order_id" IS NOT NULL AND "supply_order_item_id" IS NOT NULL)
  );

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_item_id_fkey"
  FOREIGN KEY ("receiving_entry_item_id") REFERENCES "receiving_entry_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_contract_item_contract_fkey"
  FOREIGN KEY ("contract_item_id", "contract_id") REFERENCES "contract_item"("id", "contract_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_supply_order_contract_fkey"
  FOREIGN KEY ("supply_order_id", "contract_id") REFERENCES "supply_order"("id", "contract_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_so_item_identity_fkey"
  FOREIGN KEY ("supply_order_item_id", "supply_order_id", "contract_id", "contract_item_id") REFERENCES "supply_order_item"("id", "supply_order_id", "contract_id", "contract_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receiving_entry_item_regularization"
  ADD CONSTRAINT "receiving_entry_item_regularization_user_id_fkey"
  FOREIGN KEY ("regularized_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;