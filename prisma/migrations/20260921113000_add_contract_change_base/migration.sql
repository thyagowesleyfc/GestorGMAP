CREATE TYPE "ContractChangeType" AS ENUM ('ADITIVO', 'APOSTILAMENTO');

CREATE TABLE "contract_change" (
  "id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "type" "ContractChangeType" NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "effective_on" DATE NOT NULL,
  "signed_on" DATE,
  "process_reference" VARCHAR(120),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contract_change_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contract_change_code_key" ON "contract_change"("code");
CREATE INDEX "contract_change_contract_id_idx" ON "contract_change"("contract_id");
CREATE INDEX "contract_change_type_idx" ON "contract_change"("type");
CREATE INDEX "contract_change_contract_effective_lookup_idx" ON "contract_change"("contract_id", "effective_on");

ALTER TABLE "contract_change"
  ADD CONSTRAINT "contract_change_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "contract_change"
  ADD CONSTRAINT "contract_change_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "contract_change"
  ADD CONSTRAINT "contract_change_process_reference_not_blank"
  CHECK ("process_reference" IS NULL OR length(btrim("process_reference")) > 0);

ALTER TABLE "contract_change"
  ADD CONSTRAINT "contract_change_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;