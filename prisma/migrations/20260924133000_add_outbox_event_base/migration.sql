CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

CREATE TABLE "outbox_event" (
  "id" UUID NOT NULL,
  "event_type" VARCHAR(160) NOT NULL,
  "aggregate_type" VARCHAR(120) NOT NULL,
  "aggregate_id" VARCHAR(120) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_error" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_event_event_type_idx" ON "outbox_event"("event_type");
CREATE INDEX "outbox_event_status_next_attempt_at_idx" ON "outbox_event"("status", "next_attempt_at");
CREATE INDEX "outbox_event_aggregate_lookup_idx" ON "outbox_event"("aggregate_type", "aggregate_id");
CREATE INDEX "outbox_event_created_at_idx" ON "outbox_event"("created_at");
CREATE INDEX "outbox_event_processed_at_idx" ON "outbox_event"("processed_at");

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_event_type_not_blank"
  CHECK (length(btrim("event_type")) > 0);

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_aggregate_type_not_blank"
  CHECK (length(btrim("aggregate_type")) > 0);

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_aggregate_id_not_blank"
  CHECK (length(btrim("aggregate_id")) > 0);

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_payload_object"
  CHECK (jsonb_typeof("payload") = 'object');

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_attempts_non_negative"
  CHECK ("attempts" >= 0);

ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_processed_status_requires_processed_at"
  CHECK ("status" <> 'PROCESSED' OR "processed_at" IS NOT NULL);