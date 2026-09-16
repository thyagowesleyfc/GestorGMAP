CREATE TABLE "gre" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gre_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "municipality" (
    "id" UUID NOT NULL,
    "ibge_code" VARCHAR(7) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "gre_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "municipality_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gre_code_key" ON "gre"("code");

CREATE UNIQUE INDEX "municipality_ibge_code_key" ON "municipality"("ibge_code");

CREATE INDEX "municipality_gre_id_idx" ON "municipality"("gre_id");

ALTER TABLE "gre"
    ADD CONSTRAINT "gre_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "gre"
    ADD CONSTRAINT "gre_name_not_blank"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "municipality"
    ADD CONSTRAINT "municipality_ibge_code_public_format"
    CHECK ("ibge_code" ~ '^[0-9]{7}$');

ALTER TABLE "municipality"
    ADD CONSTRAINT "municipality_name_not_blank"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "municipality"
    ADD CONSTRAINT "municipality_gre_id_fkey"
    FOREIGN KEY ("gre_id") REFERENCES "gre"("id") ON DELETE RESTRICT ON UPDATE CASCADE;