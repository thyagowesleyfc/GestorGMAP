CREATE TYPE "LogisticsRecollectionStatus" AS ENUM ('SOLICITADA', 'AUTORIZADA', 'EXECUTADA', 'CANCELADA');

CREATE TABLE "logistics_recollection" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "requesting_entity_id" UUID NOT NULL,
  "receiving_entity_id" UUID NOT NULL,
  "requested_by_user_id" UUID,
  "status" "LogisticsRecollectionStatus" NOT NULL DEFAULT 'SOLICITADA',
  "requested_at" TIMESTAMP(3) NOT NULL,
  "authorized_at" TIMESTAMP(3),
  "executed_at" TIMESTAMP(3),
  "summary" VARCHAR(500) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "logistics_recollection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "logistics_recollection_code_key" ON "logistics_recollection"("code");
CREATE INDEX "logistics_recollection_requesting_entity_id_idx" ON "logistics_recollection"("requesting_entity_id");
CREATE INDEX "logistics_recollection_receiving_entity_id_idx" ON "logistics_recollection"("receiving_entity_id");
CREATE INDEX "logistics_recollection_requested_by_user_id_idx" ON "logistics_recollection"("requested_by_user_id");
CREATE INDEX "logistics_recollection_status_idx" ON "logistics_recollection"("status");
CREATE INDEX "logistics_recollection_requested_at_idx" ON "logistics_recollection"("requested_at");
CREATE INDEX "logistics_recollection_authorized_at_idx" ON "logistics_recollection"("authorized_at");
CREATE INDEX "logistics_recollection_executed_at_idx" ON "logistics_recollection"("executed_at");

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_authorized_status_requires_authorized_at"
  CHECK ("status" <> 'AUTORIZADA' OR "authorized_at" IS NOT NULL);

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_executed_status_requires_executed_at"
  CHECK ("status" <> 'EXECUTADA' OR "executed_at" IS NOT NULL);

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_authorized_at_after_requested_at"
  CHECK ("authorized_at" IS NULL OR "authorized_at" >= "requested_at");

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_executed_at_after_requested_at"
  CHECK ("executed_at" IS NULL OR "executed_at" >= "requested_at");

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_executed_at_after_authorized_at"
  CHECK ("authorized_at" IS NULL OR "executed_at" IS NULL OR "executed_at" >= "authorized_at");

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_requesting_entity_id_fkey"
  FOREIGN KEY ("requesting_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_receiving_entity_id_fkey"
  FOREIGN KEY ("receiving_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "logistics_recollection"
  ADD CONSTRAINT "logistics_recollection_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;