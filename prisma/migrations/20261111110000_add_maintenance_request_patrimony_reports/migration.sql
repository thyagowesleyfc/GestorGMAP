CREATE TYPE "MaintenanceRequestPatrimonyReportConclusion" AS ENUM (
  'RECONDICIONAVEL',
  'IRRECUPERAVEL',
  'INDEFINIDO'
);

CREATE TABLE "maintenance_request_patrimony_report" (
  "id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "patrimony_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "conclusion" "MaintenanceRequestPatrimonyReportConclusion" NOT NULL,
  "justification" VARCHAR(1000) NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL,
  "issued_by_user_id" UUID NOT NULL,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_request_patrimony_report_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "maintenance_request_patrimony_report_target_version_key"
  ON "maintenance_request_patrimony_report"("maintenance_request_id", "patrimony_id", "version");

CREATE INDEX "maintenance_request_patrimony_report_request_patrimony_version_idx"
  ON "maintenance_request_patrimony_report"("maintenance_request_id", "patrimony_id", "version");

CREATE INDEX "maintenance_request_patrimony_report_issued_by_user_id_idx"
  ON "maintenance_request_patrimony_report"("issued_by_user_id");

ALTER TABLE "maintenance_request_patrimony_report"
  ADD CONSTRAINT "maintenance_request_patrimony_report_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "maintenance_request_patrimony_report"
  ADD CONSTRAINT "maintenance_request_patrimony_report_justification_not_blank"
  CHECK (length(btrim("justification")) > 0);

ALTER TABLE "maintenance_request_patrimony_report"
  ADD CONSTRAINT "maintenance_request_patrimony_report_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "maintenance_request_patrimony_report"
  ADD CONSTRAINT "maintenance_request_patrimony_report_target_fkey"
  FOREIGN KEY ("maintenance_request_id", "patrimony_id")
  REFERENCES "maintenance_request_patrimony_target"("maintenance_request_id", "patrimony_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_patrimony_report"
  ADD CONSTRAINT "maintenance_request_patrimony_report_issued_by_user_id_fkey"
  FOREIGN KEY ("issued_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
