import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RetombarPatrimony } from "../../src/modules/patrimony/application/retombar-patrimony";
import { PostgresPatrimonyRetomber } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-retomber";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("retombar patrimony", () => {
  it("encerra o Tombo anterior, cria novo Tombo atomicamente e e idempotente", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedRetombamento(client);
      const useCase = new RetombarPatrimony(new PostgresPatrimonyRetomber(pool));

      await expect(
        useCase.execute({
          commandId: "cmd-retombar-unauthorized",
          patrimonyId: seed.patrimonyId,
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
          commandId: "cmd-retombar-invalid-date",
          patrimonyId: seed.patrimonyId,
          retombedAt: new Date("2026-10-24T15:00:00.000Z"),
          reason: "Data anterior ao Tombo ativo",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "RETOMBED_AT_BEFORE_ISSUED_AT",
        patrimonyId: seed.patrimonyId
      });

      const unchangedAfterFailure = await client.query<{
        tombos: number;
        current_value: number;
        version: number;
      }>(
        `select
           (select count(*)::int from "patrimony_tombo" where "patrimony_id" = $1) as "tombos",
           (select "current_value" from "patrimony_tombo_sequence" where "patrimonial_group_code" = '01'),
           (select "version" from "patrimony" where "id" = $1)`,
        [seed.patrimonyId]
      );
      expect(unchangedAfterFailure.rows[0]).toEqual({ tombos: 1, current_value: 1, version: 1 });

      const input = {
        commandId: "cmd-retombar-1",
        patrimonyId: seed.patrimonyId,
        retombedAt: new Date("2026-10-26T15:00:00.000Z"),
        reason: "Retombamento por dano na identificação física",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio"
      };

      const result = await useCase.execute(input);
      expect(result).toEqual({
        ok: true,
        patrimonyId: seed.patrimonyId,
        previousTombo: "011-01-000001",
        tombo: "011-01-000002",
        patrimonialGroupCode: "01"
      });

      await expect(useCase.execute(input)).resolves.toEqual(result);

      await expect(
        useCase.execute({
          ...input,
          retombedAt: new Date("2026-10-26T16:00:00.000Z")
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        patrimonyId: seed.patrimonyId
      });

      const concurrentInput = {
        commandId: "cmd-retombar-concurrent",
        patrimonyId: seed.patrimonyId,
        retombedAt: new Date("2026-10-27T15:00:00.000Z"),
        reason: "Retombamento concorrente com a mesma chave",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio"
      };
      const concurrentResults = await Promise.all([
        useCase.execute(concurrentInput),
        useCase.execute(concurrentInput)
      ]);
      expect(concurrentResults[0]).toEqual(concurrentResults[1]);
      expect(concurrentResults[0]).toMatchObject({
        ok: true,
        previousTombo: "011-01-000002",
        tombo: "011-01-000003"
      });

      const tombos = await client.query<{
        tombo: string;
        status: string;
        retired_at: string | null;
        retirement_reason: string | null;
      }>(
        `select "tombo", "status"::text, "retired_at"::text, "retirement_reason"
           from "patrimony_tombo"
          where "patrimony_id" = $1
          order by "issued_at"`,
        [seed.patrimonyId]
      );
      expect(tombos.rows).toHaveLength(3);
      expect(tombos.rows[0]).toMatchObject({
        tombo: "011-01-000001",
        status: "ENCERRADO",
        retirement_reason: "Retombamento por dano na identificação física"
      });
      expect(tombos.rows[0]?.retired_at).not.toBeNull();
      expect(tombos.rows[1]).toMatchObject({
        tombo: "011-01-000002",
        status: "ENCERRADO",
        retirement_reason: "Retombamento concorrente com a mesma chave"
      });
      expect(tombos.rows[2]).toMatchObject({
        tombo: "011-01-000003",
        status: "ATIVO",
        retired_at: null,
        retirement_reason: null
      });

      const sequence = await client.query<{ current_value: number }>(
        `select "current_value"
           from "patrimony_tombo_sequence"
          where "patrimonial_group_code" = '01'`
      );
      expect(sequence.rows[0]?.current_value).toBe(3);

      const patrimony = await client.query<{ version: number }>(
        `select "version" from "patrimony" where "id" = $1`,
        [seed.patrimonyId]
      );
      expect(patrimony.rows[0]?.version).toBe(3);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.retombar'
            and "object_id" = $1`,
        [seed.patrimonyId]
      );
      expect(audit.rows[0]?.count).toBe(2);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.retombed'
            and "aggregate_id" = $1`,
        [seed.patrimonyId]
      );
      expect(outbox.rows[0]?.count).toBe(2);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type RetombamentoSeed = {
  patrimonyId: string;
  authorizedUserId: string;
  technicalUserId: string;
};

async function seedRetombamento(client: Client): Promise<RetombamentoSeed> {
  const greId = randomUUID();
  const greCode = "GRE-PAT-RETOMBO";
  const entityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();
  const tomboId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Retombamento', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, 'ENT-PAT-RETOMBO', 'Entidade Patrimônio Retombamento', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-RETOMBO', 'Classe Patrimônio Retombamento', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PAT-RETOMBO', 'Material para retombamento', $2, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, materialId, entityId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-01-000001', '01', $3, current_timestamp)`,
    [tomboId, patrimonyId, "2026-10-25T15:00:00.000Z"]
  );
  await client.query(
    `insert into "patrimony_tombo_sequence" (
      "id", "patrimonial_group_code", "current_value", "updated_at"
    ) values ($1, '01', 1, current_timestamp)`,
    [randomUUID()]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Retombamento', current_timestamp),
            ($2, 'Superusuário Técnico Retombamento', current_timestamp)`,
    [authorizedPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-retombo', false, current_timestamp),
             ($3, $4, 'superusuario-tecnico-retombo', true, current_timestamp)`,
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

  return { patrimonyId, authorizedUserId, technicalUserId };
}
