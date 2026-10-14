CREATE TYPE "PatrimonyTomboStatus" AS ENUM ('ATIVO', 'ENCERRADO');

CREATE TABLE "patrimony" (
  "id" UUID NOT NULL,
  "material_singular_id" UUID NOT NULL,
  "responsible_entity_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "patrimony_tombo" (
  "id" UUID NOT NULL,
  "patrimony_id" UUID NOT NULL,
  "tombo" VARCHAR(64) NOT NULL,
  "patrimonial_group_code" VARCHAR(64) NOT NULL,
  "status" "PatrimonyTomboStatus" NOT NULL DEFAULT 'ATIVO',
  "issued_at" TIMESTAMP(3) NOT NULL,
  "retired_at" TIMESTAMP(3),
  "retirement_reason" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_tombo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patrimony_material_singular_id_idx" ON "patrimony"("material_singular_id");
CREATE INDEX "patrimony_responsible_entity_id_idx" ON "patrimony"("responsible_entity_id");

CREATE UNIQUE INDEX "patrimony_tombo_tombo_key" ON "patrimony_tombo"("tombo");
CREATE UNIQUE INDEX "patrimony_tombo_active_patrimony_key"
  ON "patrimony_tombo"("patrimony_id")
  WHERE "status" = 'ATIVO' AND "retired_at" IS NULL;
CREATE INDEX "patrimony_tombo_patrimony_id_idx" ON "patrimony_tombo"("patrimony_id");
CREATE INDEX "patrimony_tombo_status_idx" ON "patrimony_tombo"("status");
CREATE INDEX "patrimony_tombo_issued_at_idx" ON "patrimony_tombo"("issued_at");
CREATE INDEX "patrimony_tombo_retired_at_idx" ON "patrimony_tombo"("retired_at");

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "patrimony_tombo"
  ADD CONSTRAINT "patrimony_tombo_tombo_format"
  CHECK ("tombo" = upper(btrim("tombo")) AND "tombo" ~ '^[A-Z0-9][A-Z0-9./-]*$');

ALTER TABLE "patrimony_tombo"
  ADD CONSTRAINT "patrimony_tombo_patrimonial_group_format"
  CHECK ("patrimonial_group_code" = upper(btrim("patrimonial_group_code")) AND length(btrim("patrimonial_group_code")) > 0);

ALTER TABLE "patrimony_tombo"
  ADD CONSTRAINT "patrimony_tombo_status_retirement_consistency"
  CHECK (
    (
      "status" = 'ATIVO'
      AND "retired_at" IS NULL
      AND "retirement_reason" IS NULL
    )
    OR (
      "status" = 'ENCERRADO'
      AND "retired_at" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
      AND length(btrim("retirement_reason")) > 0
    )
  );

ALTER TABLE "patrimony_tombo"
  ADD CONSTRAINT "patrimony_tombo_retired_at_after_issued_at"
  CHECK ("retired_at" IS NULL OR "retired_at" >= "issued_at");

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_material_singular_id_fkey"
  FOREIGN KEY ("material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_responsible_entity_id_fkey"
  FOREIGN KEY ("responsible_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_tombo"
  ADD CONSTRAINT "patrimony_tombo_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
