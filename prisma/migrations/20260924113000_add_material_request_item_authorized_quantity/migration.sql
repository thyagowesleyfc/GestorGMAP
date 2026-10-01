ALTER TABLE "material_request_item"
  ADD COLUMN "authorized_quantity" INTEGER;

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_authorized_quantity_non_negative"
  CHECK ("authorized_quantity" IS NULL OR "authorized_quantity" >= 0);

ALTER TABLE "material_request_item"
  ADD CONSTRAINT "material_request_item_authorized_quantity_not_above_requested"
  CHECK ("authorized_quantity" IS NULL OR "authorized_quantity" <= "requested_quantity");