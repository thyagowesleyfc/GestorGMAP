CREATE TABLE "patrimony_composition" (
    "id" UUID NOT NULL,
    "patrimony_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "material_configuration_id" UUID NOT NULL,
    "configuration_code" VARCHAR(64) NOT NULL,
    "configuration_name" VARCHAR(180) NOT NULL,
    "configuration_type" "MaterialConfigurationType" NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patrimony_composition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "patrimony_composition_item" (
    "id" UUID NOT NULL,
    "composition_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "material_singular_id" UUID NOT NULL,
    "component_patrimony_id" UUID,
    "quantity" INTEGER NOT NULL,
    "material_code" VARCHAR(64) NOT NULL,
    "material_name" VARCHAR(180) NOT NULL,
    "is_tombable" BOOLEAN NOT NULL,
    "patrimonial_group_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patrimony_composition_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "patrimony_composition_patrimony_revision_key"
    ON "patrimony_composition"("patrimony_id", "revision");

CREATE INDEX "patrimony_composition_material_configuration_id_idx"
    ON "patrimony_composition"("material_configuration_id");

CREATE INDEX "patrimony_composition_patrimony_recorded_at_idx"
    ON "patrimony_composition"("patrimony_id", "recorded_at");

CREATE UNIQUE INDEX "patrimony_composition_item_composition_line_key"
    ON "patrimony_composition_item"("composition_id", "line_number");

CREATE UNIQUE INDEX "patrimony_composition_item_composition_material_key"
    ON "patrimony_composition_item"("composition_id", "material_singular_id");

CREATE INDEX "patrimony_composition_item_material_singular_id_idx"
    ON "patrimony_composition_item"("material_singular_id");

CREATE INDEX "patrimony_composition_item_component_patrimony_id_idx"
    ON "patrimony_composition_item"("component_patrimony_id");

ALTER TABLE "patrimony_composition"
    ADD CONSTRAINT "patrimony_composition_revision_positive"
    CHECK ("revision" > 0);

ALTER TABLE "patrimony_composition"
    ADD CONSTRAINT "patrimony_composition_configuration_code_public_format"
    CHECK ("configuration_code" = upper(btrim("configuration_code")) AND length(btrim("configuration_code")) > 0);

ALTER TABLE "patrimony_composition"
    ADD CONSTRAINT "patrimony_composition_configuration_name_not_blank"
    CHECK (length(btrim("configuration_name")) > 0);

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_line_positive"
    CHECK ("line_number" > 0);

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_quantity_positive"
    CHECK ("quantity" > 0);

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_material_code_public_format"
    CHECK ("material_code" = upper(btrim("material_code")) AND length(btrim("material_code")) > 0);

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_material_name_not_blank"
    CHECK (length(btrim("material_name")) > 0);

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_tombable_snapshot_consistency"
    CHECK (
        ("is_tombable" = false
         AND "patrimonial_group_code" IS NULL
         AND "component_patrimony_id" IS NULL)
        OR
        ("is_tombable" = true
         AND "patrimonial_group_code" IS NOT NULL
         AND "patrimonial_group_code" ~ '^[0-9]{2}$'
         AND "component_patrimony_id" IS NOT NULL)
    );

ALTER TABLE "patrimony_composition"
    ADD CONSTRAINT "patrimony_composition_patrimony_id_fkey"
    FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_composition"
    ADD CONSTRAINT "patrimony_composition_material_configuration_id_fkey"
    FOREIGN KEY ("material_configuration_id") REFERENCES "material_configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_composition_id_fkey"
    FOREIGN KEY ("composition_id") REFERENCES "patrimony_composition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_material_singular_id_fkey"
    FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_composition_item"
    ADD CONSTRAINT "patrimony_composition_item_component_patrimony_id_fkey"
    FOREIGN KEY ("component_patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
