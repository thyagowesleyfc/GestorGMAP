CREATE TYPE "PatrimonyOperationalState" AS ENUM ('EM_USO', 'RECOLHIDO', 'EM_MANUTENCAO', 'BAIXADO');
CREATE TYPE "PatrimonyWriteOffReason" AS ENUM ('INSERVIBILIDADE', 'FURTO', 'PERDA');

ALTER TABLE "patrimony"
  ADD COLUMN "operational_state" "PatrimonyOperationalState" NOT NULL DEFAULT 'EM_USO';

CREATE TABLE "patrimony_write_off" (
    "id" UUID NOT NULL,
    "patrimony_id" UUID NOT NULL,
    "reason" "PatrimonyWriteOffReason" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "justification" VARCHAR(500) NOT NULL,
    "procedure_or_report_reference" VARCHAR(160),
    "authorization_reference" VARCHAR(160),
    "correlation_id" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patrimony_write_off_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "patrimony_write_off_patrimony_id_key"
  ON "patrimony_write_off"("patrimony_id");
CREATE INDEX "patrimony_write_off_reason_idx"
  ON "patrimony_write_off"("reason");
CREATE INDEX "patrimony_write_off_occurred_at_idx"
  ON "patrimony_write_off"("occurred_at");
CREATE INDEX "patrimony_operational_state_idx"
  ON "patrimony"("operational_state");

ALTER TABLE "patrimony_write_off"
  ADD CONSTRAINT "patrimony_write_off_justification_not_blank"
  CHECK (length(btrim("justification")) > 0);

ALTER TABLE "patrimony_write_off"
  ADD CONSTRAINT "patrimony_write_off_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "patrimony_write_off"
  ADD CONSTRAINT "patrimony_write_off_procedure_reference_not_blank"
  CHECK ("procedure_or_report_reference" IS NULL OR length(btrim("procedure_or_report_reference")) > 0);

ALTER TABLE "patrimony_write_off"
  ADD CONSTRAINT "patrimony_write_off_authorization_reference_not_blank"
  CHECK ("authorization_reference" IS NULL OR length(btrim("authorization_reference")) > 0);

ALTER TABLE "patrimony_write_off"
  ADD CONSTRAINT "patrimony_write_off_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
