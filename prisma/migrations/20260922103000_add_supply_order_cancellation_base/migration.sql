ALTER TYPE "SupplyOrderStatus" ADD VALUE 'CANCELADA';

CREATE TYPE "SupplyOrderCancellationStatus" AS ENUM ('PREPARADA', 'AUTORIZADA', 'EFETIVADA', 'REJEITADA');

CREATE TABLE "supply_order_cancellation" (
  "id" UUID NOT NULL,
  "supply_order_id" UUID NOT NULL,
  "status" "SupplyOrderCancellationStatus" NOT NULL DEFAULT 'PREPARADA',
  "reason" VARCHAR(500) NOT NULL,
  "prepared_at" TIMESTAMP(3) NOT NULL,
  "authorized_at" TIMESTAMP(3),
  "effective_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supply_order_cancellation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supply_order_cancellation_supply_order_id_key" ON "supply_order_cancellation"("supply_order_id");
CREATE INDEX "supply_order_cancellation_status_idx" ON "supply_order_cancellation"("status");

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_reason_not_blank"
  CHECK (length(btrim("reason")) > 0);

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_authorized_at_by_status"
  CHECK (("status" IN ('AUTORIZADA', 'EFETIVADA') AND "authorized_at" IS NOT NULL) OR ("status" NOT IN ('AUTORIZADA', 'EFETIVADA') AND "authorized_at" IS NULL));

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_effective_at_by_status"
  CHECK (("status" = 'EFETIVADA' AND "effective_at" IS NOT NULL) OR ("status" <> 'EFETIVADA' AND "effective_at" IS NULL));

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_rejected_at_by_status"
  CHECK (("status" = 'REJEITADA' AND "rejected_at" IS NOT NULL) OR ("status" <> 'REJEITADA' AND "rejected_at" IS NULL));

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_authorized_after_prepared"
  CHECK ("authorized_at" IS NULL OR "authorized_at" >= "prepared_at");

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_effective_after_authorized"
  CHECK ("effective_at" IS NULL OR ("authorized_at" IS NOT NULL AND "effective_at" >= "authorized_at"));

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_rejected_after_prepared"
  CHECK ("rejected_at" IS NULL OR "rejected_at" >= "prepared_at");

ALTER TABLE "supply_order_cancellation"
  ADD CONSTRAINT "supply_order_cancellation_supply_order_id_fkey"
  FOREIGN KEY ("supply_order_id") REFERENCES "supply_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;