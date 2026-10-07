CREATE TYPE "InternalNotificationTargetType" AS ENUM ('USER', 'TIME', 'LIDER', 'GERENCIA');
CREATE TYPE "InternalNotificationStatus" AS ENUM ('CRIADA', 'LIDA', 'ARQUIVADA', 'RESOLVIDA');

CREATE TABLE "internal_notification" (
  "id" UUID NOT NULL,
  "target_type" "InternalNotificationTargetType" NOT NULL,
  "target_user_id" UUID,
  "target_team_context" VARCHAR(120),
  "status" "InternalNotificationStatus" NOT NULL DEFAULT 'CRIADA',
  "title" VARCHAR(160) NOT NULL,
  "body" VARCHAR(1000) NOT NULL,
  "action_required" BOOLEAN NOT NULL DEFAULT false,
  "related_type" VARCHAR(120),
  "related_id" VARCHAR(120),
  "correlation_id" VARCHAR(160) NOT NULL,
  "read_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "internal_notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internal_notification_target_user_id_idx" ON "internal_notification"("target_user_id");
CREATE INDEX "internal_notification_target_type_target_team_context_idx" ON "internal_notification"("target_type", "target_team_context");
CREATE INDEX "internal_notification_status_idx" ON "internal_notification"("status");
CREATE INDEX "internal_notification_related_lookup_idx" ON "internal_notification"("related_type", "related_id");
CREATE INDEX "internal_notification_correlation_id_idx" ON "internal_notification"("correlation_id");
CREATE INDEX "internal_notification_created_at_idx" ON "internal_notification"("created_at");

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_user_target_shape"
  CHECK (
    (
      "target_type" = 'USER'
      AND "target_user_id" IS NOT NULL
      AND "target_team_context" IS NULL
    )
    OR (
      "target_type" <> 'USER'
      AND "target_user_id" IS NULL
      AND "target_team_context" IS NOT NULL
    )
  );

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_title_not_blank"
  CHECK (length(btrim("title")) > 0);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_body_not_blank"
  CHECK (length(btrim("body")) > 0);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_team_context_not_blank"
  CHECK ("target_team_context" IS NULL OR length(btrim("target_team_context")) > 0);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_related_complete"
  CHECK (("related_type" IS NULL AND "related_id" IS NULL) OR ("related_type" IS NOT NULL AND "related_id" IS NOT NULL));

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_related_type_not_blank"
  CHECK ("related_type" IS NULL OR length(btrim("related_type")) > 0);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_related_id_not_blank"
  CHECK ("related_id" IS NULL OR length(btrim("related_id")) > 0);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_lida_requires_read_at"
  CHECK ("status" <> 'LIDA' OR "read_at" IS NOT NULL);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_arquivada_requires_archived_at"
  CHECK ("status" <> 'ARQUIVADA' OR "archived_at" IS NOT NULL);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_resolvida_requires_resolved_at"
  CHECK ("status" <> 'RESOLVIDA' OR "resolved_at" IS NOT NULL);

ALTER TABLE "internal_notification"
  ADD CONSTRAINT "internal_notification_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;