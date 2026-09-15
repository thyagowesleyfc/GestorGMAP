CREATE TABLE "password_recovery_request" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "recovery_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "password_recovery_request_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_recovery_request_recovery_token_hash_key"
    ON "password_recovery_request"("recovery_token_hash");

CREATE INDEX "password_recovery_request_user_id_idx"
    ON "password_recovery_request"("user_id");

CREATE INDEX "password_recovery_request_expires_at_idx"
    ON "password_recovery_request"("expires_at");

CREATE INDEX "password_recovery_request_used_at_idx"
    ON "password_recovery_request"("used_at");

ALTER TABLE "password_recovery_request"
    ADD CONSTRAINT "password_recovery_request_token_hash_not_blank"
    CHECK (length(btrim("recovery_token_hash")) > 0);

ALTER TABLE "password_recovery_request"
    ADD CONSTRAINT "password_recovery_request_expires_after_created"
    CHECK ("expires_at" > "created_at");

ALTER TABLE "password_recovery_request"
    ADD CONSTRAINT "password_recovery_request_used_after_created"
    CHECK ("used_at" IS NULL OR "used_at" >= "created_at");

ALTER TABLE "password_recovery_request"
    ADD CONSTRAINT "password_recovery_request_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user_account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;