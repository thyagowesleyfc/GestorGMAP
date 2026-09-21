CREATE TABLE "contract" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "supplier_id" UUID NOT NULL,
    "object" VARCHAR(500) NOT NULL,
    "validity_start" DATE NOT NULL,
    "validity_end" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "contract_item" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "contract_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "material_singular_id" UUID,
    "material_configuration_id" UUID,
    "contracted_quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contract_code_key" ON "contract"("code");

CREATE INDEX "contract_supplier_id_idx" ON "contract"("supplier_id");

CREATE UNIQUE INDEX "contract_item_code_key" ON "contract_item"("code");

CREATE UNIQUE INDEX "contract_item_contract_line_number_key" ON "contract_item"("contract_id", "line_number");

CREATE INDEX "contract_item_contract_id_idx" ON "contract_item"("contract_id");

CREATE INDEX "contract_item_material_singular_id_idx" ON "contract_item"("material_singular_id");

CREATE INDEX "contract_item_material_configuration_id_idx" ON "contract_item"("material_configuration_id");

ALTER TABLE "contract"
    ADD CONSTRAINT "contract_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "contract"
    ADD CONSTRAINT "contract_object_not_blank"
    CHECK (length(btrim("object")) > 0);

ALTER TABLE "contract"
    ADD CONSTRAINT "contract_validity_period"
    CHECK ("validity_start" <= "validity_end");

ALTER TABLE "contract"
    ADD CONSTRAINT "contract_version_positive"
    CHECK ("version" > 0);

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_line_number_positive"
    CHECK ("line_number" > 0);

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_catalog_reference_xor"
    CHECK (("material_singular_id" IS NULL) <> ("material_configuration_id" IS NULL));

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_contracted_quantity_positive"
    CHECK ("contracted_quantity" > 0);

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_unit_price_non_negative"
    CHECK ("unit_price" >= 0);

ALTER TABLE "contract"
    ADD CONSTRAINT "contract_supplier_id_fkey"
    FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_contract_id_fkey"
    FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_material_singular_id_fkey"
    FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contract_item"
    ADD CONSTRAINT "contract_item_material_configuration_id_fkey"
    FOREIGN KEY ("material_configuration_id") REFERENCES "material_configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;