CREATE TABLE "supplier" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "tax_id" VARCHAR(14),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_code_key" ON "supplier"("code");

CREATE UNIQUE INDEX "supplier_tax_id_key" ON "supplier"("tax_id");

ALTER TABLE "supplier"
    ADD CONSTRAINT "supplier_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "supplier"
    ADD CONSTRAINT "supplier_name_not_blank"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "supplier"
    ADD CONSTRAINT "supplier_tax_id_format"
    CHECK ("tax_id" IS NULL OR "tax_id" ~ '^([0-9]{11}|[0-9]{14})$');