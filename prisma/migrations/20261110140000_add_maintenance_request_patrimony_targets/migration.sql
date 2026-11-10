CREATE TABLE "maintenance_request_patrimony_target" (
  "id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "patrimony_id" UUID NOT NULL,
  "linked_at" TIMESTAMP(3) NOT NULL,
  "linked_by_user_id" UUID NOT NULL,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_request_patrimony_target_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "maintenance_request_patrimony_target_request_patrimony_key"
  ON "maintenance_request_patrimony_target"("maintenance_request_id", "patrimony_id");

CREATE INDEX "maintenance_request_patrimony_target_patrimony_id_idx"
  ON "maintenance_request_patrimony_target"("patrimony_id");

CREATE INDEX "maintenance_request_patrimony_target_linked_by_user_id_idx"
  ON "maintenance_request_patrimony_target"("linked_by_user_id");

ALTER TABLE "maintenance_request_patrimony_target"
  ADD CONSTRAINT "maintenance_request_patrimony_target_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "maintenance_request_patrimony_target"
  ADD CONSTRAINT "maintenance_request_patrimony_target_maintenance_request_id_fkey"
  FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_patrimony_target"
  ADD CONSTRAINT "maintenance_request_patrimony_target_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_patrimony_target"
  ADD CONSTRAINT "maintenance_request_patrimony_target_linked_by_user_id_fkey"
  FOREIGN KEY ("linked_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
