CREATE TYPE "EntityType" AS ENUM (
    'ESCOLA',
    'ANEXO',
    'SALA_ESCOLAR_AVULSA',
    'SECRETARIA',
    'SUPERINTENDENCIA',
    'DIRETORIA',
    'GERENCIA',
    'COORDENACAO',
    'UNIDADE',
    'REGIONAL_GRE',
    'SETOR',
    'PREFEITURA',
    'ASSOCIACAO',
    'INSTITUICAO_FILANTROPICA'
);

CREATE UNIQUE INDEX "municipality_id_gre_id_key" ON "municipality"("id", "gre_id");

CREATE TABLE "entity" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "gre_id" UUID NOT NULL,
    "municipality_id" UUID,
    "parent_entity_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entity_code_key" ON "entity"("code");

CREATE INDEX "entity_entity_type_idx" ON "entity"("entity_type");

CREATE INDEX "entity_gre_id_idx" ON "entity"("gre_id");

CREATE INDEX "entity_municipality_id_idx" ON "entity"("municipality_id");

CREATE INDEX "entity_parent_entity_id_idx" ON "entity"("parent_entity_id");

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_code_public_format"
    CHECK ("code" = upper(btrim("code")) AND length(btrim("code")) > 0);

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_name_not_blank"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_parent_not_self"
    CHECK ("parent_entity_id" IS NULL OR "parent_entity_id" <> "id");

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_gre_id_fkey"
    FOREIGN KEY ("gre_id") REFERENCES "gre"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_municipality_id_fkey"
    FOREIGN KEY ("municipality_id") REFERENCES "municipality"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_municipality_gre_consistency_fkey"
    FOREIGN KEY ("municipality_id", "gre_id") REFERENCES "municipality"("id", "gre_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "entity"
    ADD CONSTRAINT "entity_parent_entity_id_fkey"
    FOREIGN KEY ("parent_entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;