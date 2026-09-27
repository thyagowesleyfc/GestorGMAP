CREATE TABLE "audit_entry" (
  "id" UUID NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_user_id" UUID,
  "team_context" VARCHAR(120),
  "action" VARCHAR(120) NOT NULL,
  "object_type" VARCHAR(120) NOT NULL,
  "object_id" VARCHAR(120) NOT NULL,
  "previous_value" JSONB,
  "next_value" JSONB,
  "reason" VARCHAR(500),
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_entry_actor_user_id_idx" ON "audit_entry"("actor_user_id");
CREATE INDEX "audit_entry_action_idx" ON "audit_entry"("action");
CREATE INDEX "audit_entry_object_lookup_idx" ON "audit_entry"("object_type", "object_id");
CREATE INDEX "audit_entry_correlation_id_idx" ON "audit_entry"("correlation_id");
CREATE INDEX "audit_entry_occurred_at_idx" ON "audit_entry"("occurred_at");

ALTER TABLE "audit_entry"
  ADD CONSTRAINT "audit_entry_action_not_blank"
  CHECK (length(btrim("action")) > 0);

ALTER TABLE "audit_entry"
  ADD CONSTRAINT "audit_entry_object_type_not_blank"
  CHECK (length(btrim("object_type")) > 0);

ALTER TABLE "audit_entry"
  ADD CONSTRAINT "audit_entry_object_id_not_blank"
  CHECK (length(btrim("object_id")) > 0);

ALTER TABLE "audit_entry"
  ADD CONSTRAINT "audit_entry_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "audit_entry"
  ADD CONSTRAINT "audit_entry_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;