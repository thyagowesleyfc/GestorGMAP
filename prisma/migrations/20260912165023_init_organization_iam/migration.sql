-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('MEMBRO', 'LIDER');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('GLOBAL', 'GRE');

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_technical_superuser" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_membership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "gre_code" VARCHAR(32),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_membership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_account_person_id_key" ON "user_account"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_name_key" ON "team"("name");

-- CreateIndex
CREATE INDEX "team_membership_team_id_idx" ON "team_membership"("team_id");

-- CreateIndex
CREATE INDEX "team_membership_user_id_idx" ON "team_membership"("user_id");

-- CreateIndex
CREATE INDEX "team_membership_scope_type_gre_code_idx" ON "team_membership"("scope_type", "gre_code");

-- AddCheckConstraint
ALTER TABLE "person" ADD CONSTRAINT "person_display_name_not_blank" CHECK (length(btrim("display_name")) > 0);

-- AddCheckConstraint
ALTER TABLE "team" ADD CONSTRAINT "team_name_not_blank" CHECK (length(btrim("name")) > 0);

-- AddCheckConstraint
ALTER TABLE "team_membership" ADD CONSTRAINT "team_membership_scope_consistency" CHECK (
    ("scope_type" = 'GLOBAL' AND "gre_code" IS NULL)
    OR ("scope_type" = 'GRE' AND "gre_code" IS NOT NULL AND length(btrim("gre_code")) > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "team_membership_active_scope_key" ON "team_membership"("user_id", "team_id", "scope_type", COALESCE("gre_code", '')) WHERE "active" = true;

-- AddForeignKey
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_membership" ADD CONSTRAINT "team_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_membership" ADD CONSTRAINT "team_membership_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;