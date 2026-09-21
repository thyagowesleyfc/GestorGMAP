CREATE TYPE "ContractDesignationRole" AS ENUM ('GESTOR', 'FISCAL');

CREATE TABLE "contract_designation" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "role" "ContractDesignationRole" NOT NULL,
    "holder_name" VARCHAR(180) NOT NULL,
    "holder_document" VARCHAR(14),
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_designation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contract_designation_contract_id_idx" ON "contract_designation"("contract_id");

CREATE INDEX "contract_designation_role_idx" ON "contract_designation"("role");

CREATE INDEX "contract_designation_temporal_lookup_idx" ON "contract_designation"("contract_id", "role", "starts_on", "ends_on");

ALTER TABLE "contract_designation"
    ADD CONSTRAINT "contract_designation_holder_name_not_blank"
    CHECK (length(btrim("holder_name")) > 0);

ALTER TABLE "contract_designation"
    ADD CONSTRAINT "contract_designation_holder_document_format"
    CHECK ("holder_document" IS NULL OR "holder_document" ~ '^([0-9]{11}|[0-9]{14})$');

ALTER TABLE "contract_designation"
    ADD CONSTRAINT "contract_designation_period"
    CHECK ("ends_on" IS NULL OR "starts_on" <= "ends_on");

ALTER TABLE "contract_designation"
    ADD CONSTRAINT "contract_designation_contract_id_fkey"
    FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;