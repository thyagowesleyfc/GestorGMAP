CREATE TABLE "maintenance_service_order_entity_confirmation" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "evidence_reference" VARCHAR(500) NOT NULL,
    "registered_by_user_id" UUID NOT NULL,
    "correlation_id" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_service_order_entity_confirmation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "maintenance_service_order_entity_confirmation"
    ADD CONSTRAINT "maintenance_service_order_entity_confirmation_evidence_reference_check"
    CHECK (length(btrim("evidence_reference")) > 0);

CREATE UNIQUE INDEX "maintenance_service_order_entity_confirmation_service_order_id_key"
    ON "maintenance_service_order_entity_confirmation"("service_order_id");

CREATE UNIQUE INDEX "maintenance_service_order_entity_key"
    ON "maintenance_service_order_entity_confirmation"("service_order_id", "entity_id");

CREATE UNIQUE INDEX "maintenance_service_order_id_entity_key"
    ON "maintenance_service_order"("id", "entity_id");

CREATE INDEX "maintenance_service_order_entity_confirmation_entity_id_idx"
    ON "maintenance_service_order_entity_confirmation"("entity_id");

CREATE INDEX "maintenance_service_order_entity_confirmation_registered_by_user_id_idx"
    ON "maintenance_service_order_entity_confirmation"("registered_by_user_id");

ALTER TABLE "maintenance_service_order_entity_confirmation"
    ADD CONSTRAINT "maintenance_service_order_entity_confirmation_registered_by_user_id_fkey"
    FOREIGN KEY ("registered_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order_entity_confirmation"
    ADD CONSTRAINT "maintenance_service_order_entity_confirmation_service_order_entity_key"
    FOREIGN KEY ("service_order_id", "entity_id")
    REFERENCES "maintenance_service_order"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_service_order_entity_confirmation"
    ADD CONSTRAINT "maintenance_service_order_entity_confirmation_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
