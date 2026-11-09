import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { GetPatrimonyTimeline } from "../../src/modules/patrimony/application/get-patrimony-timeline";
import { PostgresPatrimonyTimelineReader } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-timeline-reader";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("get patrimony timeline", () => {
  it("reconstrói os fatos patrimoniais com escopo e paginação determinística", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedTimeline(client);
      const query = new GetPatrimonyTimeline(new PostgresPatrimonyTimelineReader(pool));

      await expect(
        query.execute({ patrimonyId: seed.patrimonyId, actorUserId: seed.unauthorizedUserId })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });

      const firstPage = await query.execute({
        patrimonyId: seed.patrimonyId,
        actorUserId: seed.authorizedUserId,
        limit: 3,
        offset: 0
      });
      const secondPage = await query.execute({
        patrimonyId: seed.patrimonyId,
        actorUserId: seed.authorizedUserId,
        limit: 3,
        offset: 3
      });

      expect(firstPage.ok).toBe(true);
      expect(secondPage.ok).toBe(true);
      if (!firstPage.ok || !secondPage.ok) {
        return;
      }

      expect(firstPage.timeline.page).toEqual({
        limit: 3,
        offset: 0,
        returned: 3,
        total: 6
      });
      expect(secondPage.timeline.page).toEqual({
        limit: 3,
        offset: 3,
        returned: 3,
        total: 6
      });
      expect(firstPage.timeline.entries.map((entry) => entry.eventType)).toEqual([
        "RETIFICACAO",
        "BAIXA",
        "MOVIMENTO"
      ]);
      expect(secondPage.timeline.entries.map((entry) => entry.eventType)).toEqual([
        "TOMBO_ENCERRADO",
        "COMPOSICAO_REGISTRADA",
        "TOMBO_GERADO"
      ]);
      expect(firstPage.timeline.entries.map((entry) => entry.id)).not.toEqual(
        expect.arrayContaining(secondPage.timeline.entries.map((entry) => entry.id))
      );
      expect(firstPage.timeline.entries[1]?.correlationId).toBe("corr-baixa-timeline");
      expect(firstPage.timeline.entries[2]?.details).toMatchObject({
        movementType: "REMANEJAMENTO",
        reason: "Movimento de teste"
      });
      expect(secondPage.timeline.patrimony).toMatchObject({
        id: seed.patrimonyId,
        materialCode: "MAT-PAT-TIMELINE",
        responsibleEntityCode: "ENT-PAT-TIMELINE",
        operationalState: "BAIXADO"
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type TimelineSeed = {
  patrimonyId: string;
  authorizedUserId: string;
  unauthorizedUserId: string;
};

async function seedTimeline(client: Client): Promise<TimelineSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const otherEntityId = randomUUID();
  const classId = randomUUID();
  const materialId = randomUUID();
  const configId = randomUUID();
  const patrimonyId = randomUUID();
  const tomboId = randomUUID();
  const compositionId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const unauthorizedPersonId = randomUUID();
  const unauthorizedUserId = randomUUID();
  const teamId = randomUUID();
  const greCode = "GRE-PAT-TIMELINE";

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Timeline', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, 'ENT-PAT-TIMELINE', 'Entidade Timeline', 'ESCOLA', $2, current_timestamp),
             ($3, 'ENT-PAT-TIMELINE-2', 'Entidade Timeline 2', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId, otherEntityId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-TIMELINE', 'Classe Timeline', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PAT-TIMELINE', 'Material Timeline', $2, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, classId]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, 'CFG-PAT-TIMELINE', 'Configuração Timeline', 'COMPOSTO', current_timestamp)`,
    [configId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
    ) values ($1, $2, $3, 'BAIXADO', current_timestamp)`,
    [patrimonyId, materialId, entityId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "status",
      "issued_at", "retired_at", "retirement_reason", "updated_at"
    ) values ($1, $2, '011-01-000321', '01', 'ENCERRADO', $3, $4, 'Retombamento de teste', current_timestamp)`,
    [tomboId, patrimonyId, "2026-01-02T10:00:00.000Z", "2026-02-01T10:00:00.000Z"]
  );
  await client.query(
    `insert into "patrimony_composition" (
      "id", "patrimony_id", "revision", "material_configuration_id",
      "configuration_code", "configuration_name", "configuration_type",
      "recorded_at", "updated_at"
    ) values ($1, $2, 1, $3, 'CFG-PAT-TIMELINE', 'Configuração Timeline', 'COMPOSTO', $4, current_timestamp)`,
    [compositionId, patrimonyId, configId, "2026-01-03T10:00:00.000Z"]
  );
  await client.query(
    `insert into "patrimony_movement" (
      "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
      "occurred_at", "reason", "correlation_id"
    ) values ($1, $2, 'REMANEJAMENTO', $3, $4, $5, 'Movimento de teste', 'corr-movimento-timeline')`,
    [randomUUID(), patrimonyId, entityId, otherEntityId, "2026-03-01T10:00:00.000Z"]
  );
  await client.query(
    `insert into "patrimony_write_off" (
      "id", "patrimony_id", "reason", "occurred_at", "justification", "correlation_id"
    ) values ($1, $2, 'FURTO', $3, 'Baixa de teste', 'corr-baixa-timeline')`,
    [randomUUID(), patrimonyId, "2026-04-01T10:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Timeline', current_timestamp),
            ($2, 'Usuário sem escopo Timeline', current_timestamp)`,
    [authorizedPersonId, unauthorizedPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "updated_at"
    ) values ($1, $2, 'usuario-timeline', current_timestamp),
             ($3, $4, 'usuario-sem-escopo-timeline', current_timestamp)`,
    [authorizedUserId, authorizedPersonId, unauthorizedUserId, unauthorizedPersonId]
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
  await client.query(
    `insert into "audit_entry" (
      "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
      "previous_value", "next_value", "reason", "correlation_id"
    ) values ($1, $2, $3, 'Patrimônio', 'patrimony.incorporate_from_delivery', 'patrimony', $4, null, '{}', 'Incorporação', 'corr-incorporacao-timeline'),
             ($5, $6, $3, 'Patrimônio', 'patrimony.register_composition', 'patrimony_composition', $7, null, '{}', 'Composição', 'corr-composicao-timeline'),
             ($8, $9, $3, 'Patrimônio', 'patrimony.retificar', 'patrimony', $4, '{}', '{}', 'Retificação', 'corr-retificacao-timeline')`,
    [
      randomUUID(),
      "2026-01-01T10:00:00.000Z",
      authorizedUserId,
      patrimonyId,
      randomUUID(),
      "2026-01-03T10:00:00.000Z",
      compositionId,
      randomUUID(),
      "2026-05-01T10:00:00.000Z"
    ]
  );

  return { patrimonyId, authorizedUserId, unauthorizedUserId };
}
