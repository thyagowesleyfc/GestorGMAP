CREATE TABLE "material_class" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_class_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_class_code_key" ON "material_class"("code");

ALTER TABLE "material_class"
    ADD CONSTRAINT "material_class_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "material_class"
    ADD CONSTRAINT "material_class_name_not_blank"
    CHECK (length(btrim("name")) > 0);