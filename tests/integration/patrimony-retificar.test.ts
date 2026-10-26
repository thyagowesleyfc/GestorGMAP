import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RetificarPatrimony } from "../../src/modules/patrimony/application/retificar-patrimony";
import { PostgresPatrimonyRetifier } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-retifier";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("retificar patrimony", () => {
  it("corrige o Material Singular sem alterar o Tombo e e idempotente", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedRetificacao(client);
      const useCase = new RetificarPatrimony(new PostgresPatrimonyRetifier(pool));

      await expect(
        useCase.execute({
          commandId: "cmd-retificar-unauthorized",
          patrimonyId: seed.patrimonyId,
          correctedMaterialSingularId: seed.correctedMaterialId,
          reason: "Tentativa sem membership",
          actorUserId: seed.technicalUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: seed.patrimonyId
      });

      await expect(
        useCase.execute({
          commandId: "cmd-retificar-group-mismatch",
          patrimonyId: seed.patrimonyId,
          correctedMaterialSingularId: seed.differentGroupMaterialId,
          reason: "Material com grupo incompatível",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONIAL_GROUP_MISMATCH",
        patrimonyId: seed.patrimonyId
      });

      const input = {
        commandId: "cmd-retificar-1",
        patrimonyId: seed.patrimonyId,
        correctedMaterialSingularId: seed.correctedMaterialId,
        correctedAt: new Date("2026-10-26T16:00:00.000Z"),
        reason: "Corrigir cadastro do Material Singular",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio"
      };

      await expect(useCase.execute(input)).resolves.toEqual({
        ok: true,
        patrimonyId: seed.patrimonyId,
        previousMaterialSingularId: seed.originalMaterialId,
        materialSingularId: seed.correctedMaterialId,
        tombo: "011-01-000001"
      });
      await expect(useCase.execute(input)).resolves.toEqual({
        ok: true,
        patrimonyId: seed.patrimonyId,
        previousMaterialSingularId: seed.originalMaterialId,
        materialSingularId: seed.correctedMaterialId,
        tombo: "011-01-000001"
      });

      await expect(
        useCase.execute({
          ...input,
          correctedAt: new Date("2026-10-26T17:00:00.000Z")
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        patrimonyId: seed.patrimonyId
      });

      await expect(
        useCase.execute({
          ...input,
          commandId: "cmd-retificar-no-changes"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "NO_CHANGES",
        patrimonyId: seed.patrimonyId
      });

      const patrimony = await client.query<{
        material_singular_id: string;
        responsible_entity_id: string;
        version: number;
      }>(
        `select "material_singular_id", "responsible_entity_id", "version"
           from "patrimony"
          where "id" = $1`,
        [seed.patrimonyId]
      );
      expect(patrimony.rows[0]).toEqual({
        material_singular_id: seed.correctedMaterialId,
        responsible_entity_id: seed.responsibleEntityId,
        version: 2
      });

      const tombo = await client.query<{
        tombo: string;
        status: string;
        retired_at: string | null;
      }>(
        `select "tombo", "status"::text, "retired_at"::text
           from "patrimony_tombo"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(tombo.rows).toEqual([{ tombo: "011-01-000001", status: "ATIVO", retired_at: null }]);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.retificar'
            and "object_id" = $1`,
        [seed.patrimonyId]
      );
      expect(audit.rows[0]?.count).toBe(1);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.rectified'
            and "aggregate_id" = $1`,
        [seed.patrimonyId]
      );
      expect(outbox.rows[0]?.count).toBe(1);

      await client.query(
        `update "patrimony_tombo"
            set "status" = 'ENCERRADO',
                "retired_at" = $2,
                "retirement_reason" = 'Preparação de cenário sem Tombo',
                "updated_at" = current_timestamp
          where "patrimony_id" = $1`,
        [seed.patrimonyId, "2026-10-27T15:00:00.000Z"]
      );
      await expect(
        useCase.execute({
          commandId: "cmd-retificar-without-tombo",
          patrimonyId: seed.patrimonyId,
          correctedMaterialSingularId: seed.differentGroupMaterialId,
          reason: "Material tombável sem Tombo",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "TOMBO_REQUIRED_FOR_TOMBABLE_MATERIAL",
        patrimonyId: seed.patrimonyId
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type RetificacaoSeed = {
  patrimonyId: string;
  responsibleEntityId: string;
  originalMaterialId: string;
  correctedMaterialId: string;
  differentGroupMaterialId: string;
  authorizedUserId: string;
  technicalUserId: string;
};

async function seedRetificacao(client: Client): Promise<RetificacaoSeed> {
  const greId = randomUUID();
  const greCode = "GRE-PAT-RETIFICACAO";
  const entityId = randomUUID();
  const classId = randomUUID();
  const originalMaterialId = randomUUID();
  const correctedMaterialId = randomUUID();
  const differentGroupMaterialId = randomUUID();
  const patrimonyId = randomUUID();
  const tomboId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Retificação', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, 'ENT-PAT-RETIFICACAO', 'Entidade Patrimônio Retificação', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-RETIFICACAO', 'Classe Patrimônio Retificação', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-RETIFICACAO-ORIGINAL', 'Material original', $4, 'INDIVIDUAL', true, '01', current_timestamp),
             ($2, 'MAT-RETIFICACAO-CORRIGIDO', 'Material corrigido', $4, 'INDIVIDUAL', true, '01', current_timestamp),
             ($3, 'MAT-RETIFICACAO-GRUPO-02', 'Material de outro grupo', $4, 'INDIVIDUAL', true, '02', current_timestamp)`,
    [originalMaterialId, correctedMaterialId, differentGroupMaterialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, originalMaterialId, entityId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-01-000001', '01', $3, current_timestamp)`,
    [tomboId, patrimonyId, "2026-10-25T15:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Retificação', current_timestamp),
            ($2, 'Superusuário Técnico Retificação', current_timestamp)`,
    [authorizedPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-retificacao', false, current_timestamp),
             ($3, $4, 'superusuario-tecnico-retificacao', true, current_timestamp)`,
    [authorizedUserId, authorizedPersonId, technicalUserId, technicalPersonId]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Patrimônio', current_timestamp)`,
    [teamId]
  );
  await client.query(
    `insert into "team_membership" (
      "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
    ) values ($1, $2, $3, 'LIDER', 'GRE', $4, current_timestamp)`,
    [randomUUID(), authorizedUserId, teamId, greCode]
  );

  return {
    patrimonyId,
    responsibleEntityId: entityId,
    originalMaterialId,
    correctedMaterialId,
    differentGroupMaterialId,
    authorizedUserId,
    technicalUserId
  };
}
