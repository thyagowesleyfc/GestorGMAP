ALTER TYPE "PatrimonyMovementType" ADD VALUE 'RECOLHA';

ALTER TABLE "patrimony_movement"
  ADD COLUMN "logistics_recollection_id" UUID;

CREATE INDEX "patrimony_movement_logistics_recollection_id_idx"
    ON "patrimony_movement"("logistics_recollection_id");

CREATE UNIQUE INDEX "patrimony_movement_patrimony_recollection_key"
    ON "patrimony_movement"("patrimony_id", "logistics_recollection_id");

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_recollection_link_consistency"
  CHECK (
    ("movement_type"::text = 'RECOLHA' AND "logistics_recollection_id" IS NOT NULL)
    OR ("movement_type"::text <> 'RECOLHA' AND "logistics_recollection_id" IS NULL)
  );

ALTER TABLE "patrimony_movement"
  ADD CONSTRAINT "patrimony_movement_logistics_recollection_id_fkey"
  FOREIGN KEY ("logistics_recollection_id")
  REFERENCES "logistics_recollection"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
