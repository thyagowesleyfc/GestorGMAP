CREATE TYPE "PatrimonyComponentEvidenceType" AS ENUM (
  'LAUDO',
  'DOCUMENTO_ASSISTENCIA',
  'COMPROVANTE_ORDEM_FORNECEDOR',
  'EMAIL_FORMAL',
  'DOCUMENTO_SEI',
  'OUTRO'
);

CREATE TYPE "PatrimonyComponentRemovedStatus" AS ENUM (
  'REMOVIDO_EM_MANUTENCAO'
);

CREATE TYPE "PatrimonyComponentStatus" AS ENUM (
  'REMOVIDO_EM_MANUTENCAO'
);

ALTER TABLE "patrimony"
  ADD COLUMN "component_status" "PatrimonyComponentStatus";

CREATE INDEX "patrimony_component_status_idx" ON "patrimony"("component_status");

CREATE TABLE "patrimony_component_replacement" (
  "id" UUID NOT NULL,
  "patrimony_id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "previous_composition_id" UUID NOT NULL,
  "replacement_composition_id" UUID NOT NULL,
  "previous_composition_item_id" UUID NOT NULL,
  "previous_component_patrimony_id" UUID,
  "replacement_component_patrimony_id" UUID,
  "previous_material_singular_id" UUID NOT NULL,
  "replacement_material_singular_id" UUID NOT NULL,
  "replacement_origin" "PatrimonyOriginType" NOT NULL DEFAULT 'MANUTENCAO',
  "removed_status" "PatrimonyComponentRemovedStatus" NOT NULL,
  "previous_identification" VARCHAR(180),
  "replacement_identification" VARCHAR(180),
  "service_unit_reference" VARCHAR(180),
  "supplier_reference" VARCHAR(180),
  "document_reference" VARCHAR(500),
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "justification" VARCHAR(1000) NOT NULL,
  "executed_by_user_id" UUID NOT NULL,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_component_replacement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patrimony_component_replacement_patrimony_id_occurred_at_idx"
  ON "patrimony_component_replacement"("patrimony_id", "occurred_at");
CREATE INDEX "patrimony_component_replacement_maintenance_request_id_idx"
  ON "patrimony_component_replacement"("maintenance_request_id");
CREATE INDEX "patrimony_component_replacement_previous_composition_id_idx"
  ON "patrimony_component_replacement"("previous_composition_id");
CREATE INDEX "patrimony_component_replacement_replacement_composition_id_idx"
  ON "patrimony_component_replacement"("replacement_composition_id");
CREATE INDEX "patrimony_component_replacement_previous_composition_item_id_idx"
  ON "patrimony_component_replacement"("previous_composition_item_id");
CREATE INDEX "patrimony_component_replacement_previous_component_patrimony_id_idx"
  ON "patrimony_component_replacement"("previous_component_patrimony_id");
CREATE INDEX "patrimony_component_replacement_replacement_component_patrimony_id_idx"
  ON "patrimony_component_replacement"("replacement_component_patrimony_id");
CREATE INDEX "patrimony_component_replacement_executed_by_user_id_idx"
  ON "patrimony_component_replacement"("executed_by_user_id");

ALTER TABLE "patrimony_component_replacement"
  ADD CONSTRAINT "patrimony_component_replacement_components_not_self_referential"
  CHECK (
    "previous_component_patrimony_id" IS NULL
    OR "replacement_component_patrimony_id" IS NULL
    OR "previous_component_patrimony_id" <> "replacement_component_patrimony_id"
  ),
  ADD CONSTRAINT "patrimony_component_replacement_justification_not_blank"
  CHECK (length(btrim("justification")) > 0),
  ADD CONSTRAINT "patrimony_component_replacement_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "patrimony_component_replacement"
  ADD CONSTRAINT "patrimony_component_replacement_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_maintenance_request_id_fkey"
  FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_previous_composition_id_fkey"
  FOREIGN KEY ("previous_composition_id") REFERENCES "patrimony_composition"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_replacement_composition_id_fkey"
  FOREIGN KEY ("replacement_composition_id") REFERENCES "patrimony_composition"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_previous_composition_item_id_fkey"
  FOREIGN KEY ("previous_composition_item_id") REFERENCES "patrimony_composition_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_previous_component_patrimony_id_fkey"
  FOREIGN KEY ("previous_component_patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_replacement_component_patrimony_id_fkey"
  FOREIGN KEY ("replacement_component_patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_previous_material_singular_id_fkey"
  FOREIGN KEY ("previous_material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_replacement_material_singular_id_fkey"
  FOREIGN KEY ("replacement_material_singular_id") REFERENCES "material_singular"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patrimony_component_replacement_executed_by_user_id_fkey"
  FOREIGN KEY ("executed_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "patrimony_component_replacement_evidence" (
  "id" UUID NOT NULL,
  "replacement_id" UUID NOT NULL,
  "evidence_type" "PatrimonyComponentEvidenceType" NOT NULL,
  "reference" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "patrimony_component_replacement_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patrimony_component_replacement_evidence_replacement_id_idx"
  ON "patrimony_component_replacement_evidence"("replacement_id");
CREATE INDEX "patrimony_component_replacement_evidence_evidence_type_idx"
  ON "patrimony_component_replacement_evidence"("evidence_type");

ALTER TABLE "patrimony_component_replacement_evidence"
  ADD CONSTRAINT "patrimony_component_replacement_evidence_reference_not_blank"
  CHECK (length(btrim("reference")) > 0),
  ADD CONSTRAINT "patrimony_component_replacement_evidence_replacement_id_fkey"
  FOREIGN KEY ("replacement_id") REFERENCES "patrimony_component_replacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
