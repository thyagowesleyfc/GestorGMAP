ALTER TABLE "user_account"
    ADD COLUMN "login_identifier" VARCHAR(160) NOT NULL;

CREATE UNIQUE INDEX "user_account_login_identifier_key" ON "user_account"("login_identifier");

ALTER TABLE "user_account"
    ADD CONSTRAINT "user_account_login_identifier_normalized"
    CHECK (
        length(btrim("login_identifier")) > 0
        AND "login_identifier" = lower(btrim("login_identifier"))
    );
