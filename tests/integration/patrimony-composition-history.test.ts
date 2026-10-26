import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { GetPatrimonyCompositionHistory } from "../../src/modules/patrimony/application/get-patrimony-composition-history";
import { PostgresPatrimonyCompositionHistoryReader } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-composition-history-reader";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("get patrimony composition history", () => {
  it("enforces GRE scope and returns versioned snapshots with pagination", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedCompositionHistory(client);
      const query = new GetPatrimonyCompositionHistory(
        new PostgresPatrimonyCompositionHistoryReader(pool)
      );

      await expect(
        query.execute({
          patrimonyId: seed.patrimonyId,
          actorUserId: seed.unauthorizedUserId,
          limit: 1
        })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });

      const latest = await query.execute({
        patrimonyId: seed.patrimonyId,
        actorUserId: seed.authorizedUserId,
        limit: 1
      });
      expect(latest).toMatchObject({
        ok: true,
        history: {
          patrimony: {
            id: seed.patrimonyId,
            materialCode: "MAT-HISTORICO-PAI",
            responsibleEntityCode: "ENT-HISTORICO"
          },
          page: { limit: 1, offset: 0, returned: 1, total: 2 },
          revisions: [
            {
              revision: 2,
              configurationCode: "CFG-HISTORICO",
              items: [
                {
                  lineNumber: 1,
                  materialCode: "MAT-HISTORICO-COMPONENTE",
                  quantity: 1,
                  componentPatrimonyId: seed.componentPatrimonyId
                }
              ]
            }
          ]
        }
      });

      const oldest = await query.execute({
        patrimonyId: seed.patrimonyId,
        actorUserId: seed.authorizedUserId,
        limit: 1,
        offset: 1
      });
      expect(oldest).toMatchObject({
        ok: true,
        history: {
          page: { limit: 1, offset: 1, returned: 1, total: 2 },
          revisions: [{ revision: 1 }]
        }
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type CompositionHistorySeed = {
  patrimonyId: string;
  componentPatrimonyId: string;
  authorizedUserId: string;
  unauthorizedUserId: string;
};

async function seedCompositionHistory(client: Client): Promise<CompositionHistorySeed> {
  const greId = randomUUID();
  const greCode = "GRE-PAT-HISTORICO";
  const entityId = randomUUID();
  const classId = randomUUID();
  const ownerMaterialId = randomUUID();
  const componentMaterialId = randomUUID();
  const configurationId = randomUUID();
  const patrimonyId = randomUUID();
  const componentPatrimonyId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const unauthorizedPersonId = randomUUID();
  const unauthorizedUserId = randomUUID();
  const teamId = randomUUID();
  const firstCompositionId = randomUUID();
  const secondCompositionId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Histórico', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, 'ENT-HISTORICO', 'Entidade Histórico', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-HISTORICO', 'Classe Histórico', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-HISTORICO-PAI', 'Patrimônio histórico pai', $3, 'INDIVIDUAL', true, '01', current_timestamp),
             ($2, 'MAT-HISTORICO-COMPONENTE', 'Componente histórico', $3, 'INDIVIDUAL', true, '02', current_timestamp)`,
    [ownerMaterialId, componentMaterialId, classId]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, 'CFG-HISTORICO', 'Configuração histórica', 'COMPOSTO', current_timestamp)`,
    [configurationId]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp)`,
    [randomUUID(), configurationId, componentMaterialId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp),
             ($4, $5, $3, current_timestamp)`,
    [patrimonyId, ownerMaterialId, entityId, componentPatrimonyId, componentMaterialId]
  );
  await client.query(
    `insert into "patrimony_composition" (
      "id", "patrimony_id", "revision", "material_configuration_id",
      "configuration_code", "configuration_name", "configuration_type",
      "recorded_at", "updated_at"
    ) values ($1, $3, 1, $4, 'CFG-HISTORICO', 'Configuração histórica', 'COMPOSTO', $5, current_timestamp),
             ($2, $3, 2, $4, 'CFG-HISTORICO', 'Configuração histórica', 'COMPOSTO', $6, current_timestamp)`,
    [
      firstCompositionId,
      secondCompositionId,
      patrimonyId,
      configurationId,
      "2026-10-25T12:00:00.000Z",
      "2026-10-26T12:00:00.000Z"
    ]
  );
  await client.query(
    `insert into "patrimony_composition_item" (
      "id", "composition_id", "line_number", "material_singular_id",
      "component_patrimony_id", "quantity", "material_code", "material_name",
      "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, 1, $3, $4, 1, 'MAT-HISTORICO-COMPONENTE', 'Componente histórico', true, '02', current_timestamp),
             ($5, $6, 1, $3, $4, 1, 'MAT-HISTORICO-COMPONENTE', 'Componente histórico', true, '02', current_timestamp)`,
    [
      randomUUID(),
      firstCompositionId,
      componentMaterialId,
      componentPatrimonyId,
      randomUUID(),
      secondCompositionId
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Histórico', current_timestamp),
            ($2, 'Usuário Sem Escopo', current_timestamp)`,
    [authorizedPersonId, unauthorizedPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-historico', false, current_timestamp),
             ($3, $4, 'usuario-sem-escopo-historico', false, current_timestamp)`,
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
    ) values ($1, $2, $3, 'MEMBRO', 'GRE', $4, current_timestamp)`,
    [randomUUID(), authorizedUserId, teamId, greCode]
  );

  return { patrimonyId, componentPatrimonyId, authorizedUserId, unauthorizedUserId };
}
