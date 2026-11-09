CREATE TYPE "MaintenanceRequestStatus" AS ENUM (
  'REGISTRADA',
  'EM_ANALISE',
  'ATENDIMENTO_EMITIDO',
  'ATENDIDA',
  'FINALIZADA',
  'REJEITADA',
  'CANCELADA'
);

CREATE TYPE "MaintenanceRequestReferenceSystem" AS ENUM ('SEI', 'REDMINE');

CREATE TABLE "maintenance_request" (
  "id" UUID NOT NULL,
  "requesting_entity_id" UUID NOT NULL,
  "status" "MaintenanceRequestStatus" NOT NULL DEFAULT 'REGISTRADA',
  "summary" VARCHAR(500) NOT NULL,
  "description" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL,
  "registered_by_user_id" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_request_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "maintenance_request_reference" (
  "id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "system" "MaintenanceRequestReferenceSystem" NOT NULL,
  "identifier" VARCHAR(160) NOT NULL,
  "url" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_request_reference_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "maintenance_request_requesting_entity_id_idx"
  ON "maintenance_request"("requesting_entity_id");
CREATE INDEX "maintenance_request_status_idx"
  ON "maintenance_request"("status");
CREATE INDEX "maintenance_request_requested_at_idx"
  ON "maintenance_request"("requested_at");
CREATE INDEX "maintenance_request_registered_by_user_id_idx"
  ON "maintenance_request"("registered_by_user_id");
CREATE UNIQUE INDEX "maintenance_request_reference_system_identifier_key"
  ON "maintenance_request_reference"("system", "identifier");
CREATE INDEX "maintenance_request_reference_maintenance_request_id_idx"
  ON "maintenance_request_reference"("maintenance_request_id");

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_description_not_blank"
  CHECK (length(btrim("description")) > 0);

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "maintenance_request_reference"
  ADD CONSTRAINT "maintenance_request_reference_identifier_not_blank"
  CHECK (length(btrim("identifier")) > 0);

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_requesting_entity_id_fkey"
  FOREIGN KEY ("requesting_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_registered_by_user_id_fkey"
  FOREIGN KEY ("registered_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_reference"
  ADD CONSTRAINT "maintenance_request_reference_maintenance_request_id_fkey"
  FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
