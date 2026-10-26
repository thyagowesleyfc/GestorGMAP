import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RecolherPatrimony } from "../../src/modules/patrimony/application/recolher-patrimony";
import { PostgresPatrimonyRecolhedor } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-recolhedor";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("recolher patrimony", () => {
  it("aplica o efeito patrimonial somente após recolha logística executada", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedRecolha(client);
      const useCase = new RecolherPatrimony(new PostgresPatrimonyRecolhedor(pool));

      await expect(
        useCase.execute({
          commandId: "cmd-recolher-unauthorized",
          patrimonyId: seed.patrimonyId,
          logisticsRecollectionId: seed.executedRecollectionId,
          occurredAt: new Date("2026-10-27T00:00:00.000Z"),
          reason: "Tentativa sem membership",
          actorUserId: seed.technicalUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: seed.patrimonyId,
        recollectionId: seed.executedRecollectionId
      });

      await expect(
        useCase.execute({
          commandId: "cmd-recolher-not-executed",
          patrimonyId: seed.patrimonyId,
          logisticsRecollectionId: seed.authorizedRecollectionId,
          reason: "Recolha ainda não executada",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "LOGISTICS_RECOLLECTION_NOT_EXECUTED",
        patrimonyId: seed.patrimonyId,
        recollectionId: seed.authorizedRecollectionId
      });

      await expect(
        useCase.execute({
          commandId: "cmd-recolher-before-execution",
          patrimonyId: seed.patrimonyId,
          logisticsRecollectionId: seed.executedRecollectionId,
          occurredAt: new Date("2026-10-26T17:59:59.000Z"),
          reason: "Data anterior à execução",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "RECOLLECTION_DATE_BEFORE_EXECUTION",
        patrimonyId: seed.patrimonyId,
        recollectionId: seed.executedRecollectionId
      });

      const input = {
        commandId: "cmd-recolher-1",
        patrimonyId: seed.patrimonyId,
        logisticsRecollectionId: seed.executedRecollectionId,
        occurredAt: new Date("2026-10-27T00:00:00.000Z"),
        reason: "Recolha física executada",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio",
        correlationId: "corr-recolher-1"
      };

      const result = await useCase.execute(input);
      expect(result).toEqual({
        ok: true,
        movementId: expect.any(String),
        patrimonyId: seed.patrimonyId,
        recollectionId: seed.executedRecollectionId,
        fromEntityId: seed.sourceEntityId,
        toEntityId: seed.receivingEntityId
      });
      await expect(useCase.execute(input)).resolves.toEqual(result);

      await expect(
        useCase.execute({
          ...input,
          commandId: "cmd-recolher-duplicate",
          correlationId: "corr-recolher-duplicate"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_RECOLLECTION_ALREADY_REGISTERED",
        patrimonyId: seed.patrimonyId,
        recollectionId: seed.executedRecollectionId
      });

      await expect(
        useCase.execute({
          ...input,
          occurredAt: new Date("2026-10-27T01:00:00.000Z")
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
        responsible_entity_id: seed.receivingEntityId,
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
        logistics_recollection_id: string;
        from_entity_id: string;
        to_entity_id: string;
        reason: string;
      }>(
        `select "movement_type"::text, "logistics_recollection_id", "from_entity_id", "to_entity_id", "reason"
           from "patrimony_movement"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(movement.rows).toEqual([
        {
          movement_type: "RECOLHA",
          logistics_recollection_id: seed.executedRecollectionId,
          from_entity_id: seed.sourceEntityId,
          to_entity_id: seed.receivingEntityId,
          reason: "Recolha física executada"
        }
      ]);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.recolher'
            and "object_id" = $1`,
        [seed.patrimonyId]
      );
      expect(audit.rows[0]?.count).toBe(1);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.recolhido'
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

type RecolhaSeed = {
  patrimonyId: string;
  sourceEntityId: string;
  receivingEntityId: string;
  executedRecollectionId: string;
  authorizedRecollectionId: string;
  authorizedUserId: string;
  technicalUserId: string;
};

async function seedRecolha(client: Client): Promise<RecolhaSeed> {
  const greId = randomUUID();
  const sourceEntityId = randomUUID();
  const receivingEntityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();
  const tomboId = randomUUID();
  const executedRecollectionId = randomUUID();
  const authorizedRecollectionId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();
  const greCode = "GRE-PAT-RECOLHA";

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Recolha', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "active", "updated_at"
    ) values ($1, 'ENT-PAT-RECOLHA-ORIGEM', 'Entidade origem', 'ESCOLA', $3, true, current_timestamp),
             ($2, 'ENT-PAT-RECOLHA-DESTINO', 'Entidade destino', 'ESCOLA', $3, true, current_timestamp)`,
    [sourceEntityId, receivingEntityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-RECOLHA', 'Classe Patrimônio Recolha', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PAT-RECOLHA', 'Material para recolha', $2, 'INDIVIDUAL', true, '01', current_timestamp)`,
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
    `insert into "logistics_recollection" (
      "id", "code", "requesting_entity_id", "receiving_entity_id", "status",
      "requested_at", "authorized_at", "executed_at", "summary", "updated_at"
    ) values ($1, 'RECOLHA-PAT-EXECUTADA', $3, $4, 'EXECUTADA', $5, $6, $7, 'Recolha executada', current_timestamp),
             ($2, 'RECOLHA-PAT-AUTORIZADA', $3, $4, 'AUTORIZADA', $5, $6, null, 'Recolha autorizada', current_timestamp)`,
    [
      executedRecollectionId,
      authorizedRecollectionId,
      sourceEntityId,
      receivingEntityId,
      "2026-10-26T17:00:00.000Z",
      "2026-10-26T17:30:00.000Z",
      "2026-10-26T18:00:00.000Z"
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Recolha', current_timestamp),
            ($2, 'Superusuário Técnico Recolha', current_timestamp)`,
    [authorizedPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-recolha', false, current_timestamp),
             ($3, $4, 'superusuario-tecnico-recolha', true, current_timestamp)`,
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
    sourceEntityId,
    receivingEntityId,
    executedRecollectionId,
    authorizedRecollectionId,
    authorizedUserId,
    technicalUserId
  };
}
