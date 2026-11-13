CREATE TYPE "PatrimonyOriginType" AS ENUM (
  'ENTREGA',
  'SUBSTITUICAO_EM_GARANTIA'
);

CREATE TYPE "PatrimonyClosureReason" AS ENUM (
  'SUBSTITUICAO_EM_GARANTIA'
);

CREATE TYPE "PatrimonyWarrantyEvidenceType" AS ENUM (
  'LAUDO',
  'DOCUMENTO_ASSISTENCIA',
  'COMPROVANTE_ORDEM_FORNECEDOR',
  'EMAIL_FORMAL',
  'DOCUMENTO_SEI',
  'OUTRO'
);

ALTER TABLE "patrimony"
  ADD COLUMN "serial_number" VARCHAR(180),
  ADD COLUMN "origin" "PatrimonyOriginType",
  ADD COLUMN "closed_at" TIMESTAMP(3),
  ADD COLUMN "closure_reason" "PatrimonyClosureReason",
  ADD COLUMN "closed_by_user_id" UUID;

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_closure_fields_consistent"
  CHECK (
    ("closed_at" IS NULL AND "closure_reason" IS NULL AND "closed_by_user_id" IS NULL)
    OR
    ("closed_at" IS NOT NULL AND "closure_reason" IS NOT NULL AND "closed_by_user_id" IS NOT NULL)
  );

ALTER TABLE "patrimony"
  ADD CONSTRAINT "patrimony_closed_by_user_id_fkey"
  FOREIGN KEY ("closed_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "patrimony_origin_idx" ON "patrimony"("origin");
CREATE INDEX "patrimony_closed_at_idx" ON "patrimony"("closed_at");
CREATE INDEX "patrimony_closure_reason_idx" ON "patrimony"("closure_reason");
CREATE INDEX "patrimony_closed_by_user_id_idx" ON "patrimony"("closed_by_user_id");

CREATE TABLE "patrimony_warranty_replacement" (
  "id" UUID NOT NULL,
  "previous_patrimony_id" UUID NOT NULL,
  "replacement_patrimony_id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "authorized_by_user_id" UUID NOT NULL,
  "authorized_at" TIMESTAMP(3) NOT NULL,
  "executed_by_user_id" UUID NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "warranty_reference" VARCHAR(500) NOT NULL,
  "serial_number" VARCHAR(180),
  "justification" VARCHAR(1000) NOT NULL,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_warranty_replacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "patrimony_warranty_replacement_previous_patrimony_id_key"
  ON "patrimony_warranty_replacement"("previous_patrimony_id");
CREATE UNIQUE INDEX "patrimony_warranty_replacement_replacement_patrimony_id_key"
  ON "patrimony_warranty_replacement"("replacement_patrimony_id");
CREATE INDEX "patrimony_warranty_replacement_maintenance_request_id_idx"
  ON "patrimony_warranty_replacement"("maintenance_request_id");
CREATE INDEX "patrimony_warranty_replacement_authorized_by_user_id_idx"
  ON "patrimony_warranty_replacement"("authorized_by_user_id");
CREATE INDEX "patrimony_warranty_replacement_executed_by_user_id_idx"
  ON "patrimony_warranty_replacement"("executed_by_user_id");
CREATE INDEX "patrimony_warranty_replacement_occurred_at_idx"
  ON "patrimony_warranty_replacement"("occurred_at");

ALTER TABLE "patrimony_warranty_replacement"
  ADD CONSTRAINT "patrimony_warranty_replacement_not_self_referential"
  CHECK ("previous_patrimony_id" <> "replacement_patrimony_id");

ALTER TABLE "patrimony_warranty_replacement"
  ADD CONSTRAINT "patrimony_warranty_replacement_warranty_reference_not_blank"
  CHECK (length(btrim("warranty_reference")) > 0),
  ADD CONSTRAINT "patrimony_warranty_replacement_justification_not_blank"
  CHECK (length(btrim("justification")) > 0),
  ADD CONSTRAINT "patrimony_warranty_replacement_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "patrimony_warranty_replacement"
  ADD CONSTRAINT "patrimony_warranty_replacement_previous_patrimony_id_fkey"
  FOREIGN KEY ("previous_patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_warranty_replacement_replacement_patrimony_id_fkey"
  FOREIGN KEY ("replacement_patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_warranty_replacement_maintenance_request_id_fkey"
  FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_warranty_replacement_authorized_by_user_id_fkey"
  FOREIGN KEY ("authorized_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_warranty_replacement_executed_by_user_id_fkey"
  FOREIGN KEY ("executed_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "patrimony_warranty_replacement_evidence" (
  "id" UUID NOT NULL,
  "replacement_id" UUID NOT NULL,
  "evidence_type" "PatrimonyWarrantyEvidenceType" NOT NULL,
  "reference" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_warranty_replacement_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patrimony_warranty_replacement_evidence_replacement_id_idx"
  ON "patrimony_warranty_replacement_evidence"("replacement_id");
CREATE INDEX "patrimony_warranty_replacement_evidence_evidence_type_idx"
  ON "patrimony_warranty_replacement_evidence"("evidence_type");

ALTER TABLE "patrimony_warranty_replacement_evidence"
  ADD CONSTRAINT "patrimony_warranty_replacement_evidence_reference_not_blank"
  CHECK (length(btrim("reference")) > 0),
  ADD CONSTRAINT "patrimony_warranty_replacement_evidence_replacement_id_fkey"
  FOREIGN KEY ("replacement_id") REFERENCES "patrimony_warranty_replacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
