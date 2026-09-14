CREATE TABLE "password_credential" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "password_credential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_credential_user_id_key" ON "password_credential"("user_id");


ALTER TABLE "password_credential"
    ADD CONSTRAINT "password_credential_hash_not_blank"
    CHECK (length(btrim("password_hash")) > 0);

ALTER TABLE "password_credential"
    ADD CONSTRAINT "password_credential_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user_account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
