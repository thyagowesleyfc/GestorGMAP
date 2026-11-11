CREATE TYPE "MaintenanceServiceOrderStatus" AS ENUM (
  'EMITIDA',
  'ENVIADA_AO_PRESTADOR',
  'EXECUTADA',
  'ATESTADA',
  'CONCLUIDA_COM_GLOSA_PARCIAL',
  'CONCLUIDA_COM_GLOSA_TOTAL',
  'CANCELADA'
);

CREATE TABLE "maintenance_service_order" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "entity_id" UUID NOT NULL,
  "status" "MaintenanceServiceOrderStatus" NOT NULL DEFAULT 'EMITIDA',
  "issued_at" TIMESTAMP(3) NOT NULL,
  "issued_by_user_id" UUID NOT NULL,
  "correlation_id" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "maintenance_service_order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "maintenance_service_order_patrimony" (
  "id" UUID NOT NULL,
  "service_order_id" UUID NOT NULL,
  "maintenance_request_id" UUID NOT NULL,
  "patrimony_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "maintenance_service_order_patrimony_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "maintenance_service_order_service" (
  "id" UUID NOT NULL,
  "service_order_id" UUID NOT NULL,
  "line_number" INTEGER NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "maintenance_service_order_service_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "maintenance_service_order_code_key"
  ON "maintenance_service_order"("code");

CREATE UNIQUE INDEX "maintenance_service_order_id_request_key"
  ON "maintenance_service_order"("id", "maintenance_request_id");

CREATE INDEX "maintenance_service_order_request_id_idx"
  ON "maintenance_service_order"("maintenance_request_id");

CREATE INDEX "maintenance_service_order_contract_id_idx"
  ON "maintenance_service_order"("contract_id");

CREATE INDEX "maintenance_service_order_entity_id_idx"
  ON "maintenance_service_order"("entity_id");

CREATE INDEX "maintenance_service_order_status_idx"
  ON "maintenance_service_order"("status");

CREATE UNIQUE INDEX "maintenance_service_order_patrimony_unique_target"
  ON "maintenance_service_order_patrimony"("service_order_id", "patrimony_id");

CREATE INDEX "maintenance_service_order_patrimony_request_patrimony_idx"
  ON "maintenance_service_order_patrimony"("maintenance_request_id", "patrimony_id");

CREATE INDEX "maintenance_service_order_patrimony_patrimony_id_idx"
  ON "maintenance_service_order_patrimony"("patrimony_id");

CREATE UNIQUE INDEX "maintenance_service_order_service_line_key"
  ON "maintenance_service_order_service"("service_order_id", "line_number");

CREATE INDEX "maintenance_service_order_service_order_id_idx"
  ON "maintenance_service_order_service"("service_order_id");

ALTER TABLE "maintenance_service_order"
  ADD CONSTRAINT "maintenance_service_order_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "maintenance_service_order"
  ADD CONSTRAINT "maintenance_service_order_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "maintenance_service_order_patrimony"
  ADD CONSTRAINT "maintenance_service_order_patrimony_ids_not_blank"
  CHECK ("service_order_id" IS NOT NULL AND "patrimony_id" IS NOT NULL);

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_line_positive"
  CHECK ("line_number" > 0);

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_description_not_blank"
  CHECK (length(btrim("description")) > 0);

ALTER TABLE "maintenance_service_order"
  ADD CONSTRAINT "maintenance_service_order_maintenance_request_id_fkey"
  FOREIGN KEY ("maintenance_request_id") REFERENCES "maintenance_request"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order"
  ADD CONSTRAINT "maintenance_service_order_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contract"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order"
  ADD CONSTRAINT "maintenance_service_order_entity_id_fkey"
  FOREIGN KEY ("entity_id") REFERENCES "entity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order"
  ADD CONSTRAINT "maintenance_service_order_issued_by_user_id_fkey"
  FOREIGN KEY ("issued_by_user_id") REFERENCES "user_account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order_patrimony"
  ADD CONSTRAINT "maintenance_service_order_patrimony_service_order_fkey"
  FOREIGN KEY ("service_order_id", "maintenance_request_id")
  REFERENCES "maintenance_service_order"("id", "maintenance_request_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order_patrimony"
  ADD CONSTRAINT "maintenance_service_order_patrimony_target_fkey"
  FOREIGN KEY ("maintenance_request_id", "patrimony_id")
  REFERENCES "maintenance_request_patrimony_target"("maintenance_request_id", "patrimony_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order_patrimony"
  ADD CONSTRAINT "maintenance_service_order_patrimony_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order_service"
  ADD CONSTRAINT "maintenance_service_order_service_order_id_fkey"
  FOREIGN KEY ("service_order_id") REFERENCES "maintenance_service_order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
