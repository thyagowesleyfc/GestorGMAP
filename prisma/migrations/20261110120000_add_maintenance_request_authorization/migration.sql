ALTER TABLE "maintenance_request"
  ADD COLUMN "authorized_at" TIMESTAMP(3),
  ADD COLUMN "authorized_by_user_id" UUID,
  ADD COLUMN "authorization_reason" VARCHAR(1000);

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_authorized_by_user_id_fkey"
  FOREIGN KEY ("authorized_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request"
  ADD CONSTRAINT "maintenance_request_authorization_fields_consistent"
  CHECK (
    ("authorized_at" IS NULL AND "authorized_by_user_id" IS NULL AND "authorization_reason" IS NULL)
    OR
    ("authorized_at" IS NOT NULL AND "authorized_by_user_id" IS NOT NULL AND "authorization_reason" IS NOT NULL AND length(btrim("authorization_reason")) > 0)
  );

CREATE INDEX "maintenance_request_authorized_at_idx"
  ON "maintenance_request"("authorized_at");

CREATE INDEX "maintenance_request_authorized_by_user_id_idx"
  ON "maintenance_request"("authorized_by_user_id");
