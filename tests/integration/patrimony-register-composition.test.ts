import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterPatrimonyComposition } from "../../src/modules/patrimony/application/register-patrimony-composition";
import { PostgresPatrimonyCompositionRegisterer } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-composition-registerer";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("register patrimony composition", () => {
  it("records a concrete snapshot atomically and is idempotent", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedCompositionCommand(client);
      const useCase = new RegisterPatrimonyComposition(
        new PostgresPatrimonyCompositionRegisterer(pool)
      );

      await expect(
        useCase.execute({
          commandId: "cmd-composition-unauthorized",
          patrimonyId: seed.ownerPatrimonyId,
          materialConfigurationId: seed.configurationId,
          components: [
            {
              materialSingularId: seed.tombableComponentId,
              componentPatrimonyId: seed.componentPatrimonyId
            },
            { materialSingularId: seed.quantitativeComponentId }
          ],
          reason: "Tentativa sem membership",
          actorUserId: seed.technicalUserId,
          teamContext: "Patrimônio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: seed.ownerPatrimonyId
      });

      const input = {
        commandId: "cmd-composition-register",
        patrimonyId: seed.ownerPatrimonyId,
        materialConfigurationId: seed.configurationId,
        components: [
          { materialSingularId: seed.quantitativeComponentId },
          {
            materialSingularId: seed.tombableComponentId,
            componentPatrimonyId: seed.componentPatrimonyId
          }
        ],
        recordedAt: new Date("2026-10-26T15:00:00.000Z"),
        reason: "Registrar composição após conferência",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimônio"
      };

      const result = await useCase.execute(input);
      expect(result).toMatchObject({
        ok: true,
        patrimonyId: seed.ownerPatrimonyId,
        revision: 1,
        itemCount: 2
      });

      await expect(useCase.execute(input)).resolves.toEqual(result);

      await expect(
        useCase.execute({
          ...input,
          reason: "Comando reutilizado com dados diferentes"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        patrimonyId: seed.ownerPatrimonyId
      });

      const snapshot = await client.query<{
        revision: number;
        configuration_code: string;
        configuration_name: string;
        material_code: string;
        material_name: string;
        quantity: number;
        component_patrimony_id: string | null;
      }>(
        `select pc."revision", pc."configuration_code", pc."configuration_name",
                pci."material_code", pci."material_name", pci."quantity", pci."component_patrimony_id"
           from "patrimony_composition" pc
           join "patrimony_composition_item" pci on pci."composition_id" = pc."id"
          where pc."patrimony_id" = $1
          order by pci."material_code"`,
        [seed.ownerPatrimonyId]
      );
      expect(snapshot.rows).toEqual([
        {
          revision: 1,
          configuration_code: "CFG-COMPOSITION-CMD",
          configuration_name: "Composto para Command",
          material_code: "MAT-COMPONENTE-QUANTITATIVO",
          material_name: "Componente quantitativo",
          quantity: 2,
          component_patrimony_id: null
        },
        {
          revision: 1,
          configuration_code: "CFG-COMPOSITION-CMD",
          configuration_name: "Composto para Command",
          material_code: "MAT-COMPONENTE-TOMBAVEL",
          material_name: "Componente tombável",
          quantity: 1,
          component_patrimony_id: seed.componentPatrimonyId
        }
      ]);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.register_composition'
            and "object_type" = 'patrimony_composition'`
      );
      expect(audit.rows[0]?.count).toBe(1);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.composition_registered'
            and "aggregate_id" = $1`,
        [seed.ownerPatrimonyId]
      );
      expect(outbox.rows[0]?.count).toBe(1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type CompositionCommandSeed = {
  ownerPatrimonyId: string;
  componentPatrimonyId: string;
  configurationId: string;
  tombableComponentId: string;
  quantitativeComponentId: string;
  authorizedUserId: string;
  technicalUserId: string;
};

async function seedCompositionCommand(client: Client): Promise<CompositionCommandSeed> {
  const greId = randomUUID();
  const greCode = "GRE-PAT-COMMAND";
  const entityId = randomUUID();
  const classId = randomUUID();
  const ownerMaterialId = randomUUID();
  const tombableComponentId = randomUUID();
  const quantitativeComponentId = randomUUID();
  const configurationId = randomUUID();
  const ownerPatrimonyId = randomUUID();
  const componentPatrimonyId = randomUUID();
  const componentTomboId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Patrimônio Command', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, 'ENT-PAT-COMMAND', 'Entidade Patrimônio Command', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-COMMAND', 'Classe Patrimônio Command', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PATRIMONIO-PAI', 'Patrimônio pai', $4, 'INDIVIDUAL', true, '01', current_timestamp),
             ($2, 'MAT-COMPONENTE-TOMBAVEL', 'Componente tombável', $4, 'INDIVIDUAL', true, '02', current_timestamp),
             ($3, 'MAT-COMPONENTE-QUANTITATIVO', 'Componente quantitativo', $4, 'QUANTITATIVO', false, null, current_timestamp)`,
    [ownerMaterialId, tombableComponentId, quantitativeComponentId, classId]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, 'CFG-COMPOSITION-CMD', 'Composto para Command', 'COMPOSTO', current_timestamp)`,
    [configurationId]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp),
             ($4, $2, $5, 2, current_timestamp)`,
    [randomUUID(), configurationId, tombableComponentId, randomUUID(), quantitativeComponentId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "updated_at"
    ) values ($1, $2, $3, current_timestamp),
             ($4, $5, $3, current_timestamp)`,
    [ownerPatrimonyId, ownerMaterialId, entityId, componentPatrimonyId, tombableComponentId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-02-000001', '02', current_timestamp, current_timestamp)`,
    [componentTomboId, componentPatrimonyId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Patrimônio Autorizado', current_timestamp),
            ($2, 'Superusuário Técnico Sem Membership', current_timestamp)`,
    [authorizedPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, 'usuario-patrimonio-command', false, current_timestamp),
             ($3, $4, 'superusuario-tecnico-command', true, current_timestamp)`,
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
    ownerPatrimonyId,
    componentPatrimonyId,
    configurationId,
    tombableComponentId,
    quantitativeComponentId,
    authorizedUserId,
    technicalUserId
  };
}
