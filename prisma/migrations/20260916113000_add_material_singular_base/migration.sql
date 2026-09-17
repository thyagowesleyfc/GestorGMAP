CREATE TYPE "MaterialControlType" AS ENUM ('INDIVIDUAL', 'QUANTITATIVO', 'CONSUMO');

CREATE TABLE "material_singular" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "class_id" UUID NOT NULL,
    "control_type" "MaterialControlType" NOT NULL,
    "is_tombable" BOOLEAN NOT NULL DEFAULT false,
    "patrimonial_group_code" VARCHAR(64),
    "allows_corrective_maintenance" BOOLEAN NOT NULL DEFAULT false,
    "allows_preventive_maintenance" BOOLEAN NOT NULL DEFAULT false,
    "allows_reconditioning" BOOLEAN NOT NULL DEFAULT false,
    "allows_replacement" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_singular_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_singular_code_key" ON "material_singular"("code");

CREATE INDEX "material_singular_class_id_idx" ON "material_singular"("class_id");

CREATE INDEX "material_singular_control_type_idx" ON "material_singular"("control_type");

ALTER TABLE "material_singular"
    ADD CONSTRAINT "material_singular_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "material_singular"
    ADD CONSTRAINT "material_singular_name_not_blank"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "material_singular"
    ADD CONSTRAINT "material_singular_patrimonial_group_consistency"
    CHECK (
        (
            "is_tombable" = true
            AND "patrimonial_group_code" IS NOT NULL
            AND "patrimonial_group_code" = upper(btrim("patrimonial_group_code"))
            AND length(btrim("patrimonial_group_code")) > 0
        )
        OR (
            "is_tombable" = false
            AND "patrimonial_group_code" IS NULL
        )
    );

ALTER TABLE "material_singular"
    ADD CONSTRAINT "material_singular_class_id_fkey"
    FOREIGN KEY ("class_id") REFERENCES "material_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;