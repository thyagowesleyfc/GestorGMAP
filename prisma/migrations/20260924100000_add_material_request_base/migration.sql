CREATE TYPE "MaterialRequestStatus" AS ENUM ('TRIAGEM', 'NOVA', 'ANALISADA', 'DESPACHADA', 'FINALIZADA');

CREATE TABLE "material_request" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "requesting_entity_id" UUID NOT NULL,
  "status" "MaterialRequestStatus" NOT NULL DEFAULT 'TRIAGEM',
  "requested_at" TIMESTAMP(3) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "registered_by_user_id" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "material_request_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "material_request_code_key" ON "material_request"("code");
CREATE INDEX "material_request_requesting_entity_id_idx" ON "material_request"("requesting_entity_id");
CREATE INDEX "material_request_status_idx" ON "material_request"("status");
CREATE INDEX "material_request_requested_at_idx" ON "material_request"("requested_at");
CREATE INDEX "material_request_registered_by_user_id_idx" ON "material_request"("registered_by_user_id");

ALTER TABLE "material_request"
  ADD CONSTRAINT "material_request_code_public_format"
  CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "material_request"
  ADD CONSTRAINT "material_request_summary_not_blank"
  CHECK (length(btrim("summary")) > 0);

ALTER TABLE "material_request"
  ADD CONSTRAINT "material_request_version_positive"
  CHECK ("version" > 0);

ALTER TABLE "material_request"
  ADD CONSTRAINT "material_request_requesting_entity_id_fkey"
  FOREIGN KEY ("requesting_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_request"
  ADD CONSTRAINT "material_request_registered_by_user_id_fkey"
  FOREIGN KEY ("registered_by_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;