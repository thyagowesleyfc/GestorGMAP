CREATE TABLE "patrimony_tombo_sequence" (
  "id" UUID NOT NULL,
  "patrimonial_group_code" VARCHAR(64) NOT NULL,
  "current_value" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_tombo_sequence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "patrimony_tombo_sequence_group_key"
  ON "patrimony_tombo_sequence"("patrimonial_group_code");

ALTER TABLE "patrimony_tombo_sequence"
  ADD CONSTRAINT "patrimony_tombo_sequence_group_format"
  CHECK ("patrimonial_group_code" ~ '^[0-9]{2}$');

ALTER TABLE "patrimony_tombo_sequence"
  ADD CONSTRAINT "patrimony_tombo_sequence_current_value_non_negative"
  CHECK ("current_value" >= 0);
