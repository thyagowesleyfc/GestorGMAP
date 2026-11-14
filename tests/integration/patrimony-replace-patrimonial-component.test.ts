import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  ReplacePatrimonialComponent,
  type ReplacePatrimonialComponentInput
} from "../../src/modules/patrimony/application/replace-patrimonial-component";
import { PostgresPatrimonyComponentReplacer } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-component-replacer";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

async function withComponentDatabase<T>(
  callback: (client: Client, pool: Pool) => Promise<T>
): Promise<T> {
  const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  const client = new Client({ connectionString: postgres.getConnectionUri() });
  const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

  try {
    await runPrismaMigrateDeploy(postgres.getConnectionUri());
    await client.connect();
    return await callback(client, pool);
  } finally {
    await pool.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await postgres.stop();
  }
}

describe("replace patrimonial component", () => {
  it("creates a new concrete composition revision and new Patrimony/Tombo for a tombable component", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedComponentReplacement(client, true);
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      await expect(
        useCase.execute({
          ...seed.input,
          commandId: "cmd-component-unauthorized",
          actorUserId: seed.technicalUserId
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: seed.ownerPatrimonyId
      });

      await expect(
        useCase.execute({
          ...seed.input,
          commandId: "cmd-component-team-spoof",
          teamContext: "Gerência"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "TEAM_CONTEXT_NOT_AUTHORIZED",
        patrimonyId: seed.ownerPatrimonyId
      });

      const result = await useCase.execute(seed.input);
      expect(result).toEqual({
        ok: true,
        replacementId: expect.any(String),
        patrimonyId: seed.ownerPatrimonyId,
        previousCompositionId: seed.compositionId,
        replacementCompositionId: expect.any(String),
        previousRevision: 1,
        replacementRevision: 2,
        previousComponentPatrimonyId: seed.previousComponentPatrimonyId,
        replacementComponentPatrimonyId: expect.any(String),
        replacementTombo: "011-01-000002"
      });
      await expect(useCase.execute(seed.input)).resolves.toEqual(result);
      await expect(
        useCase.execute({
          ...seed.input,
          replacementIdentification: "different-payload"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT",
        patrimonyId: seed.ownerPatrimonyId,
        maintenanceRequestId: seed.maintenanceRequestId,
        compositionItemId: seed.compositionItemId
      });

      const replacementComponentPatrimonyId = result.ok
        ? result.replacementComponentPatrimonyId
        : "";
      const revisions = await client.query<{ revision: number; item_count: number }>(
        `select pc."revision", count(pci."id")::int as "item_count"
           from "patrimony_composition" pc
           join "patrimony_composition_item" pci on pci."composition_id" = pc."id"
          where pc."patrimony_id" = $1
          group by pc."revision"
          order by pc."revision"`,
        [seed.ownerPatrimonyId]
      );
      expect(revisions.rows).toEqual([
        { revision: 1, item_count: 1 },
        { revision: 2, item_count: 1 }
      ]);

      const historicalItem = await client.query<{ component_patrimony_id: string }>(
        `select "component_patrimony_id"
           from "patrimony_composition_item"
          where "composition_id" = $1`,
        [seed.compositionId]
      );
      expect(historicalItem.rows).toEqual([
        { component_patrimony_id: seed.previousComponentPatrimonyId }
      ]);

      const newTombo = await client.query<{ tombo: string; status: string }>(
        `select "tombo", "status"::text
           from "patrimony_tombo"
          where "patrimony_id" = $1`,
        [replacementComponentPatrimonyId]
      );
      expect(newTombo.rows).toEqual([{ tombo: "011-01-000002", status: "ATIVO" }]);

      const oldTombo = await client.query<{ status: string }>(
        `select "status"::text from "patrimony_tombo" where "patrimony_id" = $1`,
        [seed.previousComponentPatrimonyId]
      );
      expect(oldTombo.rows).toEqual([{ status: "ATIVO" }]);

      const removedComponent = await client.query<{
        component_status: string;
        operational_state: string;
      }>(
        `select "component_status"::text, "operational_state"::text
           from "patrimony"
          where "id" = $1`,
        [seed.previousComponentPatrimonyId]
      );
      expect(removedComponent.rows).toEqual([
        { component_status: "REMOVIDO_EM_MANUTENCAO", operational_state: "EM_MANUTENCAO" }
      ]);

      const currentComposition = await client.query<{ component_patrimony_id: string }>(
        `select pci."component_patrimony_id"
           from "patrimony_composition" pc
           join "patrimony_composition_item" pci on pci."composition_id" = pc."id"
          where pc."patrimony_id" = $1
            and not exists (
              select 1
                from "patrimony_composition" newer
               where newer."patrimony_id" = pc."patrimony_id"
                 and newer."revision" > pc."revision"
            )`,
        [seed.ownerPatrimonyId]
      );
      expect(currentComposition.rows).toEqual([
        { component_patrimony_id: replacementComponentPatrimonyId }
      ]);

      const audit = await client.query<{ team_context: string }>(
        `select "team_context"
           from "audit_entry"
          where "object_type" = 'patrimony_component_replacement'
            and "object_id" = $1`,
        [result.ok ? result.replacementId : ""]
      );
      expect(audit.rows).toEqual([{ team_context: "Patrimônio" }]);

      const replacement = await client.query<{ removed_status: string }>(
        `select "removed_status"::text
           from "patrimony_component_replacement"
          where "patrimony_id" = $1`,
        [seed.ownerPatrimonyId]
      );
      expect(replacement.rows).toEqual([{ removed_status: "REMOVIDO_EM_MANUTENCAO" }]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("replaces a non-tombable component without creating a Patrimony or Tombo", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedComponentReplacement(client, false);
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      const result = await useCase.execute(seed.input);
      expect(result).toMatchObject({
        ok: true,
        previousComponentPatrimonyId: null,
        replacementComponentPatrimonyId: null,
        replacementTombo: null,
        replacementRevision: 2
      });

      const patrimonies = await client.query<{ count: number }>(
        `select count(*)::int as "count" from "patrimony" where "responsible_entity_id" = $1`,
        [seed.entityId]
      );
      expect(patrimonies.rows[0]?.count).toBe(1);

      const replacementId = result.ok ? result.replacementId : "";
      const replacement = await client.query<{
        previous_identification: string;
        replacement_identification: string;
      }>(
        `select "previous_identification", "replacement_identification"
           from "patrimony_component_replacement"
          where "id" = $1`,
        [replacementId]
      );
      expect(replacement.rows).toEqual([
        {
          previous_identification: "OLD-NON-TOMBABLE",
          replacement_identification: "NEW-NON-TOMBABLE"
        }
      ]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("requires an OS only for a strategy that requires an OS", async () => {
    await withComponentDatabase(async (client, pool) => {
      const withoutOrder = await seedComponentReplacement(client, true, {
        strategyType: "CONTRATO_SERVICO"
      });
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      await expect(useCase.execute(withoutOrder.input)).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_SERVICE_ORDER_REQUIRED",
        patrimonyId: withoutOrder.ownerPatrimonyId,
        maintenanceRequestId: withoutOrder.maintenanceRequestId
      });
    });

    await withComponentDatabase(async (client, pool) => {
      const withOrder = await seedComponentReplacement(client, true, {
        strategyType: "CONTRATO_SERVICO",
        withServiceOrder: true
      });
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      await expect(useCase.execute(withOrder.input)).resolves.toMatchObject({
        ok: true,
        replacementRevision: 2
      });
    });
  });

  it("rejects duplicate material before writing the replacement", async () => {
    await withComponentDatabase(async (client, pool) => {
      const seed = await seedComponentReplacement(client, false);
      const replacementMaterial = await client.query<{
        code: string;
        name: string;
        is_tombable: boolean;
        patrimonial_group_code: string | null;
      }>(
        `select "code", "name", "is_tombable", "patrimonial_group_code"
           from "material_singular"
          where "id" = $1`,
        [seed.replacementMaterialId]
      );
      await client.query(
        `insert into "patrimony_composition_item" (
          "id", "composition_id", "line_number", "material_singular_id", "component_patrimony_id",
          "quantity", "material_code", "material_name", "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, 2, $3, null, 1, $4, $5, $6, $7, current_timestamp)`,
        [
          randomUUID(),
          seed.compositionId,
          seed.replacementMaterialId,
          replacementMaterial.rows[0]?.code,
          replacementMaterial.rows[0]?.name,
          replacementMaterial.rows[0]?.is_tombable,
          replacementMaterial.rows[0]?.patrimonial_group_code
        ]
      );
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      await expect(useCase.execute(seed.input)).resolves.toEqual({
        ok: false,
        reason: "REPLACEMENT_MATERIAL_ALREADY_PRESENT",
        patrimonyId: seed.ownerPatrimonyId,
        compositionItemId: seed.compositionItemId
      });

      const revisions = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "patrimony_composition"
          where "patrimony_id" = $1`,
        [seed.ownerPatrimonyId]
      );
      expect(revisions.rows[0]?.count).toBe(1);
    });
  });

  it("rejects an inconsistent component entity and an already removed component", async () => {
    await withComponentDatabase(async (client, pool) => {
      const seed = await seedComponentReplacement(client, true);
      const otherEntityId = randomUUID();
      await client.query(
        `insert into "entity" (
          "id", "code", "name", "entity_type", "gre_id", "active", "updated_at"
        ) select $1, 'ENT-COMPONENT-OTHER', 'Entidade Component Outra', "entity_type", "gre_id", true, current_timestamp
            from "entity"
           where "id" = $2`,
        [otherEntityId, seed.entityId]
      );
      await client.query(`update "patrimony" set "responsible_entity_id" = $2 where "id" = $1`, [
        seed.previousComponentPatrimonyId,
        otherEntityId
      ]);
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      await expect(useCase.execute(seed.input)).resolves.toEqual({
        ok: false,
        reason: "COMPONENT_ENTITY_MISMATCH",
        patrimonyId: seed.ownerPatrimonyId,
        compositionItemId: seed.compositionItemId
      });

      await client.query(
        `update "patrimony"
            set "responsible_entity_id" = $2,
                "component_status" = 'REMOVIDO_EM_MANUTENCAO'
          where "id" = $1`,
        [seed.previousComponentPatrimonyId, seed.entityId]
      );
      await expect(
        useCase.execute({ ...seed.input, commandId: "cmd-component-already-removed" })
      ).resolves.toEqual({
        ok: false,
        reason: "COMPONENT_ALREADY_REMOVED",
        patrimonyId: seed.ownerPatrimonyId,
        compositionItemId: seed.compositionItemId
      });
    });
  });

  it("rolls back every intermediate change when evidence persistence fails", async () => {
    await withComponentDatabase(async (client, pool) => {
      const seed = await seedComponentReplacement(client, true);
      await client.query(`
        create function test_component_replacement_failure() returns trigger
        language plpgsql
        as $$ begin raise exception 'forced component replacement failure'; return new; end; $$;
      `);
      await client.query(`
        create trigger test_component_replacement_failure_trigger
        before insert on "patrimony_component_replacement_evidence"
        for each row execute function test_component_replacement_failure();
      `);

      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));
      try {
        await expect(useCase.execute(seed.input)).rejects.toThrow(
          "forced component replacement failure"
        );
      } finally {
        await client.query(
          `drop trigger test_component_replacement_failure_trigger on "patrimony_component_replacement_evidence"`
        );
        await client.query(`drop function test_component_replacement_failure()`);
      }

      const state = await client.query<{
        operational_state: string;
        component_status: string | null;
      }>(
        `select "operational_state"::text, "component_status"::text
           from "patrimony"
          where "id" = $1`,
        [seed.previousComponentPatrimonyId]
      );
      expect(state.rows).toEqual([{ operational_state: "EM_USO", component_status: null }]);

      const counts = await client.query<{
        compositions: number;
        replacements: number;
        audit: number;
        outbox: number;
      }>(
        `select
           (select count(*) from "patrimony_composition" where "patrimony_id" = $1)::int as "compositions",
           (select count(*) from "patrimony_component_replacement")::int as "replacements",
           (select count(*) from "audit_entry")::int as "audit",
           (select count(*) from "outbox_event")::int as "outbox"`,
        [seed.ownerPatrimonyId]
      );
      expect(counts.rows[0]).toEqual({ compositions: 1, replacements: 0, audit: 0, outbox: 0 });
    });
  });

  it("allows only one concurrent replacement to win", async () => {
    await withComponentDatabase(async (client, pool) => {
      const seed = await seedComponentReplacement(client, true);
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));
      const [first, second] = await Promise.all([
        useCase.execute({ ...seed.input, commandId: "cmd-component-concurrent-1" }),
        useCase.execute({ ...seed.input, commandId: "cmd-component-concurrent-2" })
      ]);
      const results = [first, second];

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok).map((result) => result.reason)).toEqual([
        "COMPOSITION_VERSION_CONFLICT"
      ]);

      const counts = await client.query<{ compositions: number; replacements: number }>(
        `select
           (select count(*) from "patrimony_composition" where "patrimony_id" = $1)::int as "compositions",
           (select count(*) from "patrimony_component_replacement" where "patrimony_id" = $1)::int as "replacements"`,
        [seed.ownerPatrimonyId]
      );
      expect(counts.rows[0]).toEqual({ compositions: 2, replacements: 1 });
    });
  });

  it("returns domain errors for missing maintenance and missing replacement material", async () => {
    await withComponentDatabase(async (client, pool) => {
      const seed = await seedComponentReplacement(client, true);
      const useCase = new ReplacePatrimonialComponent(new PostgresPatrimonyComponentReplacer(pool));

      await expect(
        useCase.execute({
          ...seed.input,
          commandId: "cmd-component-no-maintenance",
          maintenanceRequestId: randomUUID()
        })
      ).resolves.toMatchObject({ ok: false, reason: "MAINTENANCE_REQUEST_NOT_FOUND" });
      await expect(
        useCase.execute({
          ...seed.input,
          commandId: "cmd-component-invalid-material",
          replacementMaterialSingularId: randomUUID()
        })
      ).resolves.toMatchObject({ ok: false, reason: "REPLACEMENT_MATERIAL_NOT_FOUND" });

      await client.query(
        `update "material_singular"
            set "control_type" = 'QUANTITATIVO',
                "is_tombable" = false,
                "patrimonial_group_code" = null
          where "id" = $1`,
        [seed.previousMaterialId]
      );
      await expect(
        useCase.execute({ ...seed.input, commandId: "cmd-component-inconsistent-snapshot" })
      ).resolves.toMatchObject({ ok: false, reason: "COMPOSITION_ITEM_INCONSISTENT" });
    });
  });
});

type ComponentSeed = {
  ownerPatrimonyId: string;
  previousComponentPatrimonyId: string | null;
  compositionId: string;
  compositionItemId: string;
  previousMaterialId: string;
  replacementMaterialId: string;
  maintenanceRequestId: string;
  entityId: string;
  technicalUserId: string;
  input: ReplacePatrimonialComponentInput;
};

type ComponentSeedOptions = {
  strategyType?: "GARANTIA" | "CONTRATO_SERVICO";
  withServiceOrder?: boolean;
};

async function seedComponentReplacement(
  client: Client,
  tombable: boolean,
  options: ComponentSeedOptions = {}
): Promise<ComponentSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const classId = randomUUID();
  const ownerMaterialId = randomUUID();
  const previousMaterialId = randomUUID();
  const replacementMaterialId = randomUUID();
  const ownerPatrimonyId = randomUUID();
  const previousComponentPatrimonyId = tombable ? randomUUID() : null;
  const componentTomboId = tombable ? randomUUID() : null;
  const configurationId = randomUUID();
  const compositionId = randomUUID();
  const compositionItemId = randomUUID();
  const maintenanceRequestId = randomUUID();
  const executorPersonId = randomUUID();
  const executorUserId = randomUUID();
  const managerPersonId = randomUUID();
  const managerUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const patrimonyTeamId = randomUUID();
  const strategyId = randomUUID();
  const contractId = randomUUID();
  const contractItemId = randomUUID();
  const serviceOrderId = randomUUID();
  const supplierId = randomUUID();
  const strategyType = options.strategyType ?? "GARANTIA";
  const greCode = "GRE-COMPONENT";
  const now = new Date("2026-11-13T12:00:00.000Z");
  const previousCode = tombable ? "MAT-COMPONENT-OLD-T" : "MAT-COMPONENT-OLD-N";
  const replacementCode = tombable ? "MAT-COMPONENT-NEW-T" : "MAT-COMPONENT-NEW-N";

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, 'GRE Component', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "active", "updated_at")
     values ($1, 'ENT-COMPONENT', 'Entidade Component', 'ESCOLA', $2, true, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-COMPONENT', 'Classe Component', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "active", "updated_at"
    ) values ($1, 'MAT-COMPONENT-OWNER', 'Patrimônio principal', $4, 'INDIVIDUAL', true, '01', true, current_timestamp),
             ($2, $5, 'Componente anterior', $4, $6, $7, $8, true, current_timestamp),
             ($3, $9, 'Componente substituto', $4, $6, $10, $11, true, current_timestamp)`,
    [
      ownerMaterialId,
      previousMaterialId,
      replacementMaterialId,
      classId,
      previousCode,
      tombable ? "INDIVIDUAL" : "QUANTITATIVO",
      tombable,
      tombable ? "01" : null,
      replacementCode,
      tombable,
      tombable ? "01" : null
    ]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "active", "updated_at"
    ) values ($1, 'CFG-COMPONENT', 'Configuração Component', 'KIT', true, current_timestamp)`,
    [configurationId]
  );
  await client.query(
    `insert into "patrimony" ("id", "material_singular_id", "responsible_entity_id", "origin", "updated_at")
     values ($1, $2, $3, 'ENTREGA', current_timestamp)`,
    [ownerPatrimonyId, ownerMaterialId, entityId]
  );
  if (previousComponentPatrimonyId !== null) {
    await client.query(
      `insert into "patrimony" (
        "id", "material_singular_id", "responsible_entity_id", "serial_number", "origin", "updated_at"
      ) values ($1, $2, $3, 'OLD-SERIAL', 'ENTREGA', current_timestamp)`,
      [previousComponentPatrimonyId, previousMaterialId, entityId]
    );
    await client.query(
      `insert into "patrimony_tombo" (
        "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
      ) values ($1, $2, '011-01-000001', '01', '2026-11-08T15:00:00.000Z', current_timestamp)`,
      [componentTomboId, previousComponentPatrimonyId]
    );
    await client.query(
      `insert into "patrimony_tombo_sequence" (
        "id", "patrimonial_group_code", "current_value", "updated_at"
      ) values ($1, '01', 1, current_timestamp)`,
      [randomUUID()]
    );
  }
  await client.query(
    `insert into "patrimony_composition" (
      "id", "patrimony_id", "revision", "material_configuration_id", "configuration_code",
      "configuration_name", "configuration_type", "recorded_at", "updated_at"
    ) values ($1, $2, 1, $3, 'CFG-COMPONENT', 'Configuração Component', 'KIT', $4, current_timestamp)`,
    [compositionId, ownerPatrimonyId, configurationId, now]
  );
  await client.query(
    `insert into "patrimony_composition_item" (
      "id", "composition_id", "line_number", "material_singular_id", "component_patrimony_id",
      "quantity", "material_code", "material_name", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, 1, $3, $4, 1, $5, 'Componente anterior', $6, $7, current_timestamp)`,
    [
      compositionItemId,
      compositionId,
      previousMaterialId,
      previousComponentPatrimonyId,
      previousCode,
      tombable,
      tombable ? "01" : null
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Executor Component', current_timestamp),
            ($2, 'Gerência Component', current_timestamp),
            ($3, 'Técnico Component', current_timestamp)`,
    [executorPersonId, managerPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, 'executor-component', current_timestamp),
            ($3, $4, 'manager-component', current_timestamp),
            ($5, $6, 'technical-component', current_timestamp)`,
    [
      executorUserId,
      executorPersonId,
      managerUserId,
      managerPersonId,
      technicalUserId,
      technicalPersonId
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values ($1, 'Patrimônio', current_timestamp)`,
    [patrimonyTeamId]
  );
  await client.query(
    `insert into "team_membership" (
      "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
    ) values ($1, $2, $3, 'MEMBRO', 'GRE', $4, current_timestamp)`,
    [randomUUID(), executorUserId, patrimonyTeamId, greCode]
  );
  await client.query(
    `insert into "maintenance_request" (
      "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
      "authorized_at", "authorized_by_user_id", "authorization_reason", "correlation_id", "updated_at"
    ) values ($1, $2, 'EM_ANALISE', 'Manutenção de componente', 'Substituição de componente', $3,
              $3, $4, 'Autorização da Gerência', 'corr-maintenance-component', current_timestamp)`,
    [maintenanceRequestId, entityId, now, managerUserId]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
      "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id", "correlation_id", "updated_at"
    ) values ($1, $2, $3, $4, $5, 'corr-target-component', current_timestamp)`,
    [randomUUID(), maintenanceRequestId, ownerPatrimonyId, now, executorUserId]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_strategy" (
      "id", "maintenance_request_id", "patrimony_id", "strategy_type", "justification",
      "defined_at", "defined_by_user_id", "correlation_id", "updated_at"
    ) values ($1, $2, $3, 'GARANTIA', 'Substituição de componente em garantia', $4, $5, 'corr-strategy-component', current_timestamp)`,
    [strategyId, maintenanceRequestId, ownerPatrimonyId, now, executorUserId]
  );

  if (strategyType === "CONTRATO_SERVICO") {
    await client.query(
      `insert into "supplier" ("id", "code", "name", "updated_at")
       values ($1, 'SUP-COMPONENT', 'Fornecedor Component', current_timestamp)`,
      [supplierId]
    );
    await client.query(
      `insert into "contract" (
        "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
      ) values ($1, 'CTR-COMPONENT', $2, 'Contrato Component', '2026-01-01', '2026-12-31', true, current_timestamp)`,
      [contractId, supplierId]
    );
    await client.query(
      `insert into "contract_item" (
        "id", "code", "contract_id", "line_number", "material_singular_id",
        "contracted_quantity", "unit_price", "updated_at"
      ) values ($1, 'CTR-COMPONENT-ITEM', $2, 1, $3, 10, 100.00, current_timestamp)`,
      [contractItemId, contractId, ownerMaterialId]
    );
    await client.query(
      `update "maintenance_request_patrimony_strategy"
          set "strategy_type" = 'CONTRATO_SERVICO',
              "contract_id" = $2,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [strategyId, contractId]
    );
    if (options.withServiceOrder === true) {
      await client.query(
        `insert into "maintenance_service_order" (
          "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
          "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
        ) values ($1, 'OS-COMPONENT', $2, $3, $4, 'EMITIDA', $5, $6, 'corr-os-component', current_timestamp)`,
        [serviceOrderId, maintenanceRequestId, contractId, entityId, now, executorUserId]
      );
      await client.query(
        `insert into "maintenance_service_order_patrimony" (
          "id", "service_order_id", "maintenance_request_id", "patrimony_id"
        ) values ($1, $2, $3, $4)`,
        [randomUUID(), serviceOrderId, maintenanceRequestId, ownerPatrimonyId]
      );
    }
  }

  return {
    ownerPatrimonyId,
    previousComponentPatrimonyId,
    compositionId,
    compositionItemId,
    previousMaterialId,
    replacementMaterialId,
    maintenanceRequestId,
    entityId,
    technicalUserId,
    input: {
      commandId: "cmd-component-1",
      patrimonyId: ownerPatrimonyId,
      maintenanceRequestId,
      compositionItemId,
      expectedRevision: 1,
      replacementMaterialSingularId: replacementMaterialId,
      replacementSerialNumber: tombable ? "NEW-SERIAL" : undefined,
      previousIdentification: tombable ? undefined : "OLD-NON-TOMBABLE",
      replacementIdentification: tombable ? undefined : "NEW-NON-TOMBABLE",
      serviceUnitReference: "ASSISTENCIA-UTD",
      supplierReference: "FORNECEDOR-001",
      documentReference: "DOC-COMPONENT-001",
      evidences: [{ type: "DOCUMENTO_ASSISTENCIA", reference: "ASSISTENCIA-001" }],
      justification: "Substituição formal do componente.",
      occurredAt: now,
      actorUserId: executorUserId,
      teamContext: "Patrimônio",
      correlationId: "corr-component-replacement"
    }
  };
}
