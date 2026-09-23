CREATE TYPE "CommandIdempotencyStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

CREATE TABLE "command_idempotency" (
  "id" uuid NOT NULL,
  "command_name" varchar(120) NOT NULL,
  "idempotency_key" varchar(160) NOT NULL,
  "request_hash" char(64) NOT NULL,
  "status" "CommandIdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "result_json" jsonb,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  CONSTRAINT "command_idempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "command_idempotency_command_key"
  ON "command_idempotency"("command_name", "idempotency_key");

CREATE INDEX "command_idempotency_status_idx"
  ON "command_idempotency"("status");

ALTER TABLE "command_idempotency"
  ADD CONSTRAINT "command_idempotency_key_not_blank"
  CHECK (btrim("idempotency_key") <> '');

ALTER TABLE "command_idempotency"
  ADD CONSTRAINT "command_idempotency_request_hash_format"
  CHECK ("request_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "command_idempotency"
  ADD CONSTRAINT "command_idempotency_succeeded_has_result"
  CHECK ("status" <> 'SUCCEEDED' OR "result_json" IS NOT NULL);