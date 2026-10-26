CREATE TYPE "PatrimonyMovementType" AS ENUM ('REMANEJAMENTO');

CREATE TABLE "patrimony_movement" (
    "id" UUID NOT NULL,
    "patrimony_id" UUID NOT NULL,
    "movement_type" "PatrimonyMovementType" NOT NULL,
    "from_entity_id" UUID NOT NULL,
    "to_entity_id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "correlation_id" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patrimony_movement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patrimony_movement_patrimony_occurred_at_idx"
    ON "patrimony_movement"("patrimony_id", "occurred_at");
CREATE INDEX "patrimony_movement_from_entity_occurred_at_idx"
    ON "patrimony_movement"("from_entity_id", "occurred_at");
CREATE INDEX "patrimony_movement_to_entity_occurred_at_idx"
    ON "patrimony_movement"("to_entity_id", "occurred_at");

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_distinct_entities"
  CHECK ("from_entity_id" <> "to_entity_id");

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_reason_not_blank"
  CHECK (length(btrim("reason")) > 0);

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_patrimony_id_fkey"
  FOREIGN KEY ("patrimony_id") REFERENCES "patrimony"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_from_entity_id_fkey"
  FOREIGN KEY ("from_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_to_entity_id_fkey"
  FOREIGN KEY ("to_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
