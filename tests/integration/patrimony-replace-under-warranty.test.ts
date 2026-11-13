import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { ReplacePatrimonyUnderWarranty } from "../../src/modules/patrimony/application/replace-patrimony-under-warranty";
import { PostgresPatrimonyWarrantyReplacer } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-warranty-replacer";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("replace patrimony under warranty", () => {
  it("creates the replacement atomically, preserves the old Tombo, and replays retries", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedWarrantyReplacement(client);
      const useCase = new ReplacePatrimonyUnderWarranty(
        new PostgresPatrimonyWarrantyReplacer(pool)
      );

      await expect(
        useCase.execute({
          ...seed.input,
          commandId: "cmd-warranty-unauthorized",
          actorUserId: seed.technicalUserId
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: seed.patrimonyId
      });

      const result = await useCase.execute(seed.input);
      expect(result).toEqual({
        ok: true,
        replacementId: expect.any(String),
        previousPatrimonyId: seed.patrimonyId,
        replacementPatrimonyId: expect.any(String),
        replacementTombo: "011-01-000002"
      });
      await expect(useCase.execute(seed.input)).resolves.toEqual(result);

      const replacementId = result.ok ? result.replacementId : "";
      const replacementPatrimonyId = result.ok ? result.replacementPatrimonyId : "";

      const oldPatrimony = await client.query<{
        operational_state: string;
        closed_at: Date;
        closure_reason: string;
        version: number;
      }>(
        `select "operational_state"::text, "closed_at", "closure_reason"::text, "version"
           from "patrimony"
          where "id" = $1`,
        [seed.patrimonyId]
      );
      expect(oldPatrimony.rows[0]).toMatchObject({
        operational_state: "EM_USO",
        closure_reason: "SUBSTITUICAO_EM_GARANTIA",
        version: 2
      });
      expect(oldPatrimony.rows[0]?.closed_at).toEqual(seed.input.occurredAt);

      const oldTombo = await client.query<{
        tombo: string;
        status: string;
        retirement_reason: string;
      }>(
        `select "tombo", "status"::text, "retirement_reason"
           from "patrimony_tombo"
          where "patrimony_id" = $1`,
        [seed.patrimonyId]
      );
      expect(oldTombo.rows).toEqual([
        {
          tombo: "011-01-000001",
          status: "ENCERRADO",
          retirement_reason: "SUBSTITUICAO_EM_GARANTIA"
        }
      ]);

      const replacementPatrimony = await client.query<{
        responsible_entity_id: string;
        origin: string;
        operational_state: string;
        serial_number: string;
      }>(
        `select "responsible_entity_id", "origin"::text, "operational_state"::text, "serial_number"
           from "patrimony"
          where "id" = $1`,
        [replacementPatrimonyId]
      );
      expect(replacementPatrimony.rows).toEqual([
        {
          responsible_entity_id: seed.entityId,
          origin: "SUBSTITUICAO_EM_GARANTIA",
          operational_state: "EM_USO",
          serial_number: "SERIAL-WARRANTY-001"
        }
      ]);

      const replacementTombo = await client.query<{ tombo: string; status: string }>(
        `select "tombo", "status"::text
           from "patrimony_tombo"
          where "patrimony_id" = $1`,
        [replacementPatrimonyId]
      );
      expect(replacementTombo.rows).toEqual([{ tombo: "011-01-000002", status: "ATIVO" }]);

      const replacement = await client.query<{
        previous_patrimony_id: string;
        replacement_patrimony_id: string;
        maintenance_request_id: string;
        authorized_by_user_id: string;
        executed_by_user_id: string;
      }>(
        `select "previous_patrimony_id", "replacement_patrimony_id", "maintenance_request_id",
                "authorized_by_user_id", "executed_by_user_id"
           from "patrimony_warranty_replacement"
          where "id" = $1`,
        [replacementId]
      );
      expect(replacement.rows).toEqual([
        {
          previous_patrimony_id: seed.patrimonyId,
          replacement_patrimony_id: replacementPatrimonyId,
          maintenance_request_id: seed.maintenanceRequestId,
          authorized_by_user_id: seed.managerUserId,
          executed_by_user_id: seed.executorUserId
        }
      ]);

      const evidence = await client.query<{ evidence_type: string; reference: string }>(
        `select "evidence_type"::text, "reference"
           from "patrimony_warranty_replacement_evidence"
          where "replacement_id" = $1`,
        [replacementId]
      );
      expect(evidence.rows).toEqual([{ evidence_type: "LAUDO", reference: "LAUDO-001" }]);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.replaced_under_warranty'
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

  it("serializes different commands for the same old Patrimony", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedWarrantyReplacement(client);
      const useCase = new ReplacePatrimonyUnderWarranty(
        new PostgresPatrimonyWarrantyReplacer(pool)
      );

      const [first, second] = await Promise.all([
        useCase.execute(seed.input),
        useCase.execute({ ...seed.input, commandId: "cmd-warranty-concurrent-2" })
      ]);

      expect([first, second].filter((result) => result.ok)).toHaveLength(1);
      expect(
        [first, second].filter(
          (result) => !result.ok && result.reason === "PATRIMONY_ALREADY_CLOSED"
        )
      ).toHaveLength(1);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type WarrantySeed = {
  patrimonyId: string;
  entityId: string;
  maintenanceRequestId: string;
  managerUserId: string;
  executorUserId: string;
  technicalUserId: string;
  input: Parameters<ReplacePatrimonyUnderWarranty["execute"]>[0];
};

async function seedWarrantyReplacement(client: Client): Promise<WarrantySeed> {
  const greId = randomUUID();
  const greCode = "GRE-WARRANTY";
  const entityId = randomUUID();
  const classId = randomUUID();
  const oldMaterialId = randomUUID();
  const replacementMaterialId = randomUUID();
  const patrimonyId = randomUUID();
  const oldTomboId = randomUUID();
  const maintenanceRequestId = randomUUID();
  const targetId = randomUUID();
  const strategyId = randomUUID();
  const executorPersonId = randomUUID();
  const executorUserId = randomUUID();
  const managerPersonId = randomUUID();
  const managerUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const patrimonyTeamId = randomUUID();
  const gerenciaTeamId = randomUUID();
  const now = new Date("2026-11-13T12:00:00.000Z");

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, 'GRE Warranty', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "active", "updated_at")
     values ($1, 'ENT-WARRANTY', 'Entidade Warranty', 'ESCOLA', $2, true, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-WARRANTY', 'Classe Warranty', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "active", "updated_at"
    ) values ($1, 'MAT-WARRANTY-OLD', 'Material Antigo', $3, 'INDIVIDUAL', true, '01', true, current_timestamp),
             ($2, 'MAT-WARRANTY-NEW', 'Material Substituto', $3, 'INDIVIDUAL', true, '01', true, current_timestamp)`,
    [oldMaterialId, replacementMaterialId, classId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "origin", "updated_at"
    ) values ($1, $2, $3, 'ENTREGA', current_timestamp)`,
    [patrimonyId, oldMaterialId, entityId]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-01-000001', '01', '2026-11-08T15:00:00.000Z', current_timestamp)`,
    [oldTomboId, patrimonyId]
  );
  await client.query(
    `insert into "patrimony_tombo_sequence" (
      "id", "patrimonial_group_code", "current_value", "updated_at"
    ) values ($1, '01', 1, current_timestamp)`,
    [randomUUID()]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Executor Warranty', current_timestamp),
            ($2, 'Gerência Warranty', current_timestamp),
            ($3, 'Técnico Warranty', current_timestamp)`,
    [executorPersonId, managerPersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, 'executor-warranty', current_timestamp),
            ($3, $4, 'manager-warranty', current_timestamp),
            ($5, $6, 'technical-warranty', current_timestamp)`,
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
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Patrimônio', current_timestamp), ($2, 'Gerência', current_timestamp)`,
    [patrimonyTeamId, gerenciaTeamId]
  );
  await client.query(
    `insert into "team_membership" (
      "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
    ) values ($1, $2, $3, 'MEMBRO', 'GRE', $4, current_timestamp),
             ($5, $6, $7, 'LIDER', 'GRE', $4, current_timestamp)`,
    [
      randomUUID(),
      executorUserId,
      patrimonyTeamId,
      greCode,
      randomUUID(),
      managerUserId,
      gerenciaTeamId
    ]
  );
  await client.query(
    `insert into "maintenance_request" (
      "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
      "registered_by_user_id", "authorized_at", "authorized_by_user_id", "authorization_reason",
      "correlation_id", "updated_at"
    ) values ($1, $2, 'EM_ANALISE', 'Garantia', 'Substituição integral em garantia', $3,
              $4, $3, $5, 'Autorização da Gerência', 'corr-maintenance-warranty', current_timestamp)`,
    [maintenanceRequestId, entityId, now, managerUserId, managerUserId]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
      "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id", "correlation_id", "updated_at"
    ) values ($1, $2, $3, $4, $5, 'corr-target-warranty', current_timestamp)`,
    [targetId, maintenanceRequestId, patrimonyId, now, executorUserId]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_strategy" (
      "id", "maintenance_request_id", "patrimony_id", "strategy_type", "justification",
      "defined_at", "defined_by_user_id", "correlation_id", "updated_at"
    ) values ($1, $2, $3, 'GARANTIA', 'Cobertura de garantia', $4, $5, 'corr-strategy-warranty', current_timestamp)`,
    [strategyId, maintenanceRequestId, patrimonyId, now, executorUserId]
  );

  return {
    patrimonyId,
    entityId,
    maintenanceRequestId,
    managerUserId,
    executorUserId,
    technicalUserId,
    input: {
      commandId: "cmd-warranty-1",
      patrimonyId,
      maintenanceRequestId,
      replacementMaterialSingularId: replacementMaterialId,
      warrantyReference: "ATENDIMENTO-GARANTIA-001",
      evidences: [{ type: "LAUDO", reference: "LAUDO-001" }],
      justification: "Substituição integral autorizada em garantia.",
      serialNumber: "SERIAL-WARRANTY-001",
      occurredAt: now,
      actorUserId: executorUserId,
      teamContext: "Patrimônio",
      correlationId: "corr-replacement-warranty"
    }
  };
}
