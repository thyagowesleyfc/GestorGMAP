CREATE TYPE "MaintenanceRequestPatrimonyStrategyType" AS ENUM (
  'UTD',
  'CERME',
  'CONTRATO_SERVICO',
  'GARANTIA',
  'AVALIACAO_BAIXA'
);

CREATE TABLE "maintenance_request_patrimony_strategy" (
  "id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "patrimony_id" UUID NOT NULL,
  "strategy_type" "MaintenanceRequestPatrimonyStrategyType" NOT NULL,
  "contract_id" UUID,
  "justification" VARCHAR(1000) NOT NULL,
  "defined_at" TIMESTAMP(3) NOT NULL,
  "defined_by_user_id" UUID NOT NULL,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "maintenance_request_patrimony_strategy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "maintenance_request_patrimony_strategy_request_patrimony_key"
  ON "maintenance_request_patrimony_strategy"("maintenance_request_id", "patrimony_id");

CREATE INDEX "maintenance_request_patrimony_strategy_patrimony_id_idx"
  ON "maintenance_request_patrimony_strategy"("patrimony_id");

CREATE INDEX "maintenance_request_patrimony_strategy_contract_id_idx"
  ON "maintenance_request_patrimony_strategy"("contract_id");

CREATE INDEX "maintenance_request_patrimony_strategy_defined_by_user_id_idx"
  ON "maintenance_request_patrimony_strategy"("defined_by_user_id");

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_justification_not_blank"
  CHECK (length(btrim("justification")) > 0);

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_contract_consistent"
  CHECK (
    ("strategy_type" = 'CONTRATO_SERVICO' AND "contract_id" IS NOT NULL)
    OR
    ("strategy_type" <> 'CONTRATO_SERVICO' AND "contract_id" IS NULL)
  );

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_maintenance_request_id_fkey"
  FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_request_patrimony_strategy"
  ADD CONSTRAINT "maintenance_request_patrimony_strategy_defined_by_user_id_fkey"
  FOREIGN KEY ("defined_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
