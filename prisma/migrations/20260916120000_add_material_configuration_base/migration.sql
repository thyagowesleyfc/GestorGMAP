CREATE TYPE "MaterialConfigurationType" AS ENUM ('KIT', 'COMPOSTO');

CREATE TABLE "material_configuration" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "configuration_type" "MaterialConfigurationType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_configuration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "material_configuration_component" (
    "id" UUID NOT NULL,
    "configuration_id" UUID NOT NULL,
    "material_singular_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_configuration_component_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_configuration_code_key" ON "material_configuration"("code");

CREATE INDEX "material_configuration_configuration_type_idx" ON "material_configuration"("configuration_type");

CREATE UNIQUE INDEX "material_configuration_component_unique_item"
    ON "material_configuration_component"("configuration_id", "material_singular_id");

CREATE INDEX "material_configuration_component_material_singular_id_idx"
    ON "material_configuration_component"("material_singular_id");

ALTER TABLE "material_configuration"
    ADD CONSTRAINT "material_configuration_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "material_configuration"
    ADD CONSTRAINT "material_configuration_name_not_blank"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "material_configuration_component"
    ADD CONSTRAINT "material_configuration_component_quantity_positive"
    CHECK ("quantity" > 0);

ALTER TABLE "material_configuration_component"
    ADD CONSTRAINT "material_configuration_component_configuration_id_fkey"
    FOREIGN KEY ("configuration_id") REFERENCES "material_configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_configuration_component"
    ADD CONSTRAINT "material_configuration_component_material_singular_id_fkey"
    FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;