CREATE TABLE "user_session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_token_hash" TEXT NOT NULL,
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(64),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_session_session_token_hash_key" ON "user_session"("session_token_hash");

CREATE INDEX "user_session_user_id_idx" ON "user_session"("user_id");

CREATE INDEX "user_session_expires_at_idx" ON "user_session"("expires_at");

CREATE INDEX "user_session_revoked_at_idx" ON "user_session"("revoked_at");

ALTER TABLE "user_session"
    ADD CONSTRAINT "user_session_token_hash_not_blank"
    CHECK (length(btrim("session_token_hash")) > 0);

ALTER TABLE "user_session"
    ADD CONSTRAINT "user_session_expires_after_created"
    CHECK ("expires_at" > "created_at");

ALTER TABLE "user_session"
    ADD CONSTRAINT "user_session_revoked_after_created"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

ALTER TABLE "user_session"
    ADD CONSTRAINT "user_session_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user_account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
