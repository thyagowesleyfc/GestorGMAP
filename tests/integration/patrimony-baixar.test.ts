import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { BaixarPatrimony } from "../../src/modules/patrimony/application/baixar-patrimony";
import { PostgresPatrimonyBaixador } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-baixador";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("baixar patrimony", () => {
  it("baixa atomicamente, encerra o Tombo e é idempotente", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedBaixa(client);
      const useCase = new BaixarPatrimony(new PostgresPatrimonyBaixador(pool));

      await expect(
        useCase.execute({
          commandId: "cmd-baixar-unauthorized",
          patrimonyId: seed.patrimonyId,
          reason: "FURTO",
          occurredAt: new Date("2026-11-09T18:00:00.000Z"),
          justification: "Ocorrência sem membership",
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
          commandId: "cmd-baixar-before-tombo",
          patrimonyId: seed.patrimonyId,
          reason: "FURTO",
          occurredAt: new Date("2026-11-08T14:00:00.000Z"),
          justification: "Data inválida",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "WRITEOFF_DATE_BEFORE_TOMBO_ISSUANCE",
        patrimonyId: seed.patrimonyId
      });

      await expect(
        useCase.execute({
          commandId: "cmd-baixar-tombable-without-report",
          patrimonyId: seed.patrimonyId,
          reason: "INSERVIBILIDADE",
          occurredAt: new Date("2026-11-09T18:00:00.000Z"),
          justification: "Suporte obrigatório para bem tombável",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "INVALID_PROCEDURE_OR_REPORT_REFERENCE",
        patrimonyId: seed.patrimonyId
      });

      const input = {
        commandId: "cmd-baixar-1",
        patrimonyId: seed.patrimonyId,
        reason: "INSERVIBILIDADE",
        occurredAt: new Date("2026-11-09T18:00:00.000Z"),
        justification: "Bem sem recuperação após avaliação",
        procedureOrReportReference: "LAUDO-BAIXA-001",
        authorizationReference: "AUT-BAIXA-001",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio",
        correlationId: "corr-baixar-1"
      };

      const result = await useCase.execute(input);
      expect(result).toEqual({
        ok: true,
        writeOffId: expect.any(String),
        patrimonyId: seed.patrimonyId,
        status: "BAIXADO",
        activeTomboRetired: true
      });
      await expect(useCase.execute(input)).resolves.toEqual(result);

      await expect(
        useCase.execute({
          ...input,
          commandId: "cmd-baixar-duplicate",
          correlationId: "corr-baixar-duplicate"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_ALREADY_WRITTEN_OFF",
        patrimonyId: seed.patrimonyId
      });

      await expect(
        useCase.execute({
          commandId: "cmd-baixar-quantitative",
          patrimonyId: seed.quantitativePatrimonyId,
          reason: "INSERVIBILIDADE",
          occurredAt: new Date("2026-11-09T18:00:00.000Z"),
          justification: "Baixa quantitativa sem laudo individual",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toMatchObject({
        ok: true,
        patrimonyId: seed.quantitativePatrimonyId,
        status: "BAIXADO",
        activeTomboRetired: false
      });

      await expect(
        useCase.execute({
          ...input,
          occurredAt: new Date("2026-11-09T19:00:00.000Z")
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        patrimonyId: seed.patrimonyId
      });

      const patrimony = await client.query<{
        operational_state: string;
        responsible_entity_id: string;
        version: number;
      }>(
        `select "operational_state"::text, "responsible_entity_id", "version"
           from "patrimony"
          where "id" = $1`,
        [seed.patrimonyId]
      );
      expect(patrimony.rows[0]).toEqual({
        operational_state: "BAIXADO",
        responsible_entity_id: seed.entityId,
        version: 2
      });

      const tombo = await client.query<{
        tombo: string;
        status: string;
        retirement_reason: string;
      }>(
        `select "tombo", "status"::text, "retirement_reason"
           from "patrimony_tombo"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(tombo.rows).toEqual([
        {
          tombo: "011-01-000001",
          status: "ENCERRADO",
          retirement_reason: "Bem sem recuperação após avaliação"
        }
      ]);

      const writeOff = await client.query<{
        reason: string;
        justification: string;
        procedure_or_report_reference: string;
        authorization_reference: string;
      }>(
        `select "reason"::text, "justification", "procedure_or_report_reference", "authorization_reference"
           from "patrimony_write_off"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(writeOff.rows).toEqual([
        {
          reason: "INSERVIBILIDADE",
          justification: "Bem sem recuperação após avaliação",
          procedure_or_report_reference: "LAUDO-BAIXA-001",
          authorization_reference: "AUT-BAIXA-001"
        }
      ]);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.baixar'
            and "object_id" = $1`,
        [seed.patrimonyId]
      );
      expect(audit.rows[0]?.count).toBe(1);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.baixado'
            and "aggregate_id" = $1`,
        [seed.patrimonyId]
      );
      expect(outbox.rows[0]?.count).toBe(1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type BaixaSeed = {
  patrimonyId: string;
  quantitativePatrimonyId: string;
  entityId: string;
  authorizedUserId: string;
  technicalUserId: string;
};

async function seedBaixa(client: Client): Promise<BaixaSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();
  const quantitativeMaterialId = randomUUID();
  const quantitativePatrimonyId = randomUUID();
  const tomboId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();
  const greCode = "GRE-PAT-BAIXA";

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Baixa', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "active", "updated_at"
    ) values ($1, 'ENT-PAT-BAIXA', 'Entidade Baixa', 'ESCOLA', $2, true, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-BAIXA', 'Classe Patrimônio Baixa', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PAT-BAIXA', 'Material para baixa', $2, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, materialId, entityId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "updated_at"
    ) values ($1, 'MAT-PAT-BAIXA-QUANTITATIVO', 'Material quantitativo para baixa', $2, 'QUANTITATIVO', false, current_timestamp)`,
    [quantitativeMaterialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [quantitativePatrimonyId, quantitativeMaterialId, entityId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-01-000001', '01', $3, current_timestamp)`,
    [tomboId, patrimonyId, "2026-11-08T15:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Baixa', current_timestamp),
            ($2, 'Superusuário Técnico Baixa', current_timestamp)`,
    [authorizedPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-baixa', false, current_timestamp),
             ($3, $4, 'superusuario-tecnico-baixa', true, current_timestamp)`,
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

  return { patrimonyId, quantitativePatrimonyId, entityId, authorizedUserId, technicalUserId };
}
