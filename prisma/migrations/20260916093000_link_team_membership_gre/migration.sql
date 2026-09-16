DO $$
DECLARE
    orphan_codes text;
BEGIN
    SELECT string_agg(DISTINCT "team_membership"."gre_code", ', ' ORDER BY "team_membership"."gre_code")
      INTO orphan_codes
      FROM "team_membership"
 LEFT JOIN "gre"
        ON "gre"."code" = "team_membership"."gre_code"
     WHERE "team_membership"."scope_type" = 'GRE'
       AND "team_membership"."gre_code" IS NOT NULL
       AND "gre"."id" IS NULL;

    IF orphan_codes IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot link team_membership.gre_code to gre.code because orphan GRE scope codes exist: %', orphan_codes
            USING ERRCODE = '23503';
    END IF;
END $$;

ALTER TABLE "team_membership"
    DROP CONSTRAINT IF EXISTS "team_membership_scope_consistency";

ALTER TABLE "team_membership"
    ADD CONSTRAINT "team_membership_scope_consistency"
    CHECK (
        ("scope_type" = 'GLOBAL' AND "gre_code" IS NULL)
        OR (
            "scope_type" = 'GRE'
            AND "gre_code" IS NOT NULL
            AND "gre_code" = upper(btrim("gre_code"))
            AND length(btrim("gre_code")) > 0
        )
    );

ALTER TABLE "team_membership"
    ADD CONSTRAINT "team_membership_gre_code_fkey"
    FOREIGN KEY ("gre_code") REFERENCES "gre"("code") ON DELETE RESTRICT ON UPDATE CASCADE;