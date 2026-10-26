import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { EmprestarPatrimony } from "../../src/modules/patrimony/application/emprestar-patrimony";
import { PostgresPatrimonyEmprestador } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-emprestador";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("emprestar patrimony", () => {
  it("registra empréstimo idempotente e preserva o Tombo", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedEmprestimo(client);
      const useCase = new EmprestarPatrimony(new PostgresPatrimonyEmprestador(pool));

      await expect(
        useCase.execute({
          commandId: "cmd-emprestar-unauthorized",
          patrimonyId: seed.patrimonyId,
          destinationEntityId: seed.destinationEntityId,
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
          commandId: "cmd-emprestar-same-entity",
          patrimonyId: seed.patrimonyId,
          destinationEntityId: seed.sourceEntityId,
          reason: "Mesma entidade",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "SAME_RESPONSIBLE_ENTITY",
        patrimonyId: seed.patrimonyId
      });

      const input = {
        commandId: "cmd-emprestar-1",
        patrimonyId: seed.patrimonyId,
        destinationEntityId: seed.destinationEntityId,
        occurredAt: new Date("2026-10-26T18:00:00.000Z"),
        reason: "Uso temporário por outra entidade",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio",
        correlationId: "corr-emprestar-1"
      };

      const result = await useCase.execute(input);
      expect(result).toEqual({
        ok: true,
        movementId: expect.any(String),
        patrimonyId: seed.patrimonyId,
        fromEntityId: seed.sourceEntityId,
        toEntityId: seed.destinationEntityId
      });
      await expect(useCase.execute(input)).resolves.toEqual(result);

      await expect(
        useCase.execute({
          ...input,
          occurredAt: new Date("2026-10-26T19:00:00.000Z")
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        patrimonyId: seed.patrimonyId
      });

      const patrimony = await client.query<{
        responsible_entity_id: string;
        version: number;
      }>(
        `select "responsible_entity_id", "version"
           from "patrimony"
          where "id" = $1`,
        [seed.patrimonyId]
      );
      expect(patrimony.rows[0]).toEqual({
        responsible_entity_id: seed.destinationEntityId,
        version: 2
      });

      const tombo = await client.query<{ tombo: string; status: string }>(
        `select "tombo", "status"::text
           from "patrimony_tombo"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(tombo.rows).toEqual([{ tombo: "011-01-000001", status: "ATIVO" }]);

      const movement = await client.query<{
        movement_type: string;
        from_entity_id: string;
        to_entity_id: string;
        reason: string;
      }>(
        `select "movement_type"::text, "from_entity_id", "to_entity_id", "reason"
           from "patrimony_movement"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(movement.rows).toEqual([
        {
          movement_type: "EMPRESTIMO",
          from_entity_id: seed.sourceEntityId,
          to_entity_id: seed.destinationEntityId,
          reason: "Uso temporário por outra entidade"
        }
      ]);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.emprestar'
            and "object_id" = $1`,
        [seed.patrimonyId]
      );
      expect(audit.rows[0]?.count).toBe(1);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.emprestado'
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

type EmprestimoSeed = {
  patrimonyId: string;
  sourceEntityId: string;
  destinationEntityId: string;
  authorizedUserId: string;
  technicalUserId: string;
};

async function seedEmprestimo(client: Client): Promise<EmprestimoSeed> {
  const greId = randomUUID();
  const sourceEntityId = randomUUID();
  const destinationEntityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();
  const tomboId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();
  const greCode = "GRE-PAT-EMPRESTIMO";

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Empréstimo', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "active", "updated_at"
    ) values ($1, 'ENT-PAT-EMPRESTIMO-ORIGEM', 'Entidade origem', 'ESCOLA', $3, true, current_timestamp),
             ($2, 'ENT-PAT-EMPRESTIMO-DESTINO', 'Entidade destino', 'ESCOLA', $3, true, current_timestamp)`,
    [sourceEntityId, destinationEntityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-EMPRESTIMO', 'Classe Patrimônio Empréstimo', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PAT-EMPRESTIMO', 'Material para empréstimo', $2, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [patrimonyId, materialId, sourceEntityId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-01-000001', '01', $3, current_timestamp)`,
    [tomboId, patrimonyId, "2026-10-25T15:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Empréstimo', current_timestamp),
            ($2, 'Superusuário Técnico Empréstimo', current_timestamp)`,
    [authorizedPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-emprestimo', false, current_timestamp),
             ($3, $4, 'superusuario-tecnico-emprestimo', true, current_timestamp)`,
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

  return { patrimonyId, sourceEntityId, destinationEntityId, authorizedUserId, technicalUserId };
}
