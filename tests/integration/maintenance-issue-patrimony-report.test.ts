import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { IssueMaintenanceRequestPatrimonyReportInput } from "../../src/modules/maintenance/application/issue-maintenance-request-patrimony-report";
import { IssueMaintenanceRequestPatrimonyReport } from "../../src/modules/maintenance/application/issue-maintenance-request-patrimony-report";
import { PostgresMaintenanceRequestPatrimonyReportIssuer } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-request-patrimony-report-issuer";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("issue and version maintenance patrimony reports", () => {
  it("emits v1, preserves it on correction v2, and keeps failures atomic and idempotent", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedDependencies(client);
      const useCase = new IssueMaintenanceRequestPatrimonyReport(
        new PostgresMaintenanceRequestPatrimonyReportIssuer(pool)
      );

      const initialSnapshot = await takeSnapshot(client, seed);
      const v1Command = reportCommand(seed, {
        commandId: "cmd-maintenance-report-v1-001",
        conclusion: "IRRECUPERAVEL",
        justification: "Laudo conclui pela impossibilidade de recuperação.",
        correlationId: "corr-maintenance-report-v1-001",
        issuedAt: new Date("2026-11-11T14:00:00.000Z")
      });

      await expect(useCase.execute(v1Command)).resolves.toEqual({
        ok: true,
        reportId: expect.any(String),
        maintenanceRequestId: seed.authorizedRequestId,
        patrimonyId: seed.validPatrimonyId,
        version: 1,
        conclusion: "IRRECUPERAVEL",
        status: "EM_ANALISE"
      });

      const afterV1 = await takeSnapshot(client, seed);
      expect(afterV1.reports).toHaveLength(1);
      expect(afterV1.reports[0]).toMatchObject({
        version: 1,
        conclusion: "IRRECUPERAVEL",
        justification: "Laudo conclui pela impossibilidade de recuperação.",
        issued_by_user_id: seed.globalPatrimonyUserId,
        correlation_id: "corr-maintenance-report-v1-001"
      });
      expect(afterV1.auditCount).toBe(initialSnapshot.auditCount + 1);
      expect(afterV1.outboxCount).toBe(initialSnapshot.outboxCount + 1);
      expect(afterV1.writeOffCount).toBe(initialSnapshot.writeOffCount);
      expect(afterV1.movementCount).toBe(initialSnapshot.movementCount);
      expect(afterV1.patrimonyStates).toEqual(initialSnapshot.patrimonyStates);

      await expect(useCase.execute(v1Command)).resolves.toEqual({
        ok: true,
        reportId: afterV1.reports[0].id,
        maintenanceRequestId: seed.authorizedRequestId,
        patrimonyId: seed.validPatrimonyId,
        version: 1,
        conclusion: "IRRECUPERAVEL",
        status: "EM_ANALISE"
      });
      await expect(
        useCase.execute({
          ...v1Command,
          justification: "Tentativa de reutilizar a chave com outro conteúdo."
        })
      ).resolves.toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(await takeSnapshot(client, seed)).toEqual(afterV1);

      const v2Command = reportCommand(seed, {
        commandId: "cmd-maintenance-report-v2-001",
        conclusion: "RECONDICIONAVEL",
        justification: "Correção: o bem pode ser recondicionado.",
        actorUserId: seed.compatibleGrePatrimonyUserId,
        correlationId: "corr-maintenance-report-v2-001",
        issuedAt: new Date("2026-11-11T15:00:00.000Z")
      });
      const v2Result = await useCase.execute(v2Command);
      expect(v2Result).toEqual({
        ok: true,
        reportId: expect.any(String),
        maintenanceRequestId: seed.authorizedRequestId,
        patrimonyId: seed.validPatrimonyId,
        version: 2,
        conclusion: "RECONDICIONAVEL",
        status: "EM_ANALISE"
      });

      const afterV2 = await takeSnapshot(client, seed);
      expect(afterV2.reports).toHaveLength(2);
      expect(afterV2.reports[0]).toMatchObject({
        id: afterV1.reports[0].id,
        version: 1,
        conclusion: "IRRECUPERAVEL",
        justification: "Laudo conclui pela impossibilidade de recuperação.",
        correlation_id: "corr-maintenance-report-v1-001"
      });
      expect(afterV2.reports[1]).toMatchObject({
        version: 2,
        conclusion: "RECONDICIONAVEL",
        justification: "Correção: o bem pode ser recondicionado.",
        issued_by_user_id: seed.compatibleGrePatrimonyUserId,
        correlation_id: "corr-maintenance-report-v2-001"
      });
      expect(afterV2.auditCount).toBe(initialSnapshot.auditCount + 2);
      expect(afterV2.outboxCount).toBe(initialSnapshot.outboxCount + 2);
      expect(afterV2.patrimonyStates).toEqual(initialSnapshot.patrimonyStates);
      expect(afterV2.writeOffCount).toBe(initialSnapshot.writeOffCount);
      expect(afterV2.movementCount).toBe(initialSnapshot.movementCount);

      const beforeMissingStrategy = await takeSnapshot(client, seed);
      await expect(
        useCase.execute(
          reportCommand(seed, {
            commandId: "cmd-maintenance-report-no-strategy-001",
            patrimonyId: seed.linkedWithoutStrategyPatrimonyId,
            conclusion: "INDEFINIDO",
            justification: "Alvo vinculado, mas ainda sem estratégia definida.",
            correlationId: "corr-maintenance-report-no-strategy-001"
          })
        )
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_STRATEGY_NOT_DEFINED",
        patrimonyId: seed.linkedWithoutStrategyPatrimonyId
      });
      expect(await takeSnapshot(client, seed)).toEqual(beforeMissingStrategy);

      const beforeUnauthorizedActor = await takeSnapshot(client, seed);
      await expect(
        useCase.execute(
          reportCommand(seed, {
            commandId: "cmd-maintenance-report-unauthorized-actor-001",
            actorUserId: seed.unauthorizedActorUserId,
            conclusion: "INDEFINIDO",
            justification: "Ator fora do escopo de Patrimônio.",
            correlationId: "corr-maintenance-report-unauthorized-actor-001"
          })
        )
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: seed.validPatrimonyId
      });
      expect(await takeSnapshot(client, seed)).toEqual(beforeUnauthorizedActor);

      const beforeUnauthorizedRequest = await takeSnapshot(client, seed);
      await expect(
        useCase.execute(
          reportCommand(seed, {
            commandId: "cmd-maintenance-report-request-not-authorized-001",
            maintenanceRequestId: seed.unauthorizedRequestId,
            conclusion: "INDEFINIDO",
            justification: "Solicitação ainda não autorizada pela Gerência.",
            correlationId: "corr-maintenance-report-request-not-authorized-001"
          })
        )
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: seed.unauthorizedRequestId,
        patrimonyId: seed.validPatrimonyId
      });
      expect(await takeSnapshot(client, seed)).toEqual(beforeUnauthorizedRequest);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);
});

type ReportOverrides = Partial<IssueMaintenanceRequestPatrimonyReportInput>;

function reportCommand(
  seed: ReportSeed,
  overrides: ReportOverrides = {}
): IssueMaintenanceRequestPatrimonyReportInput {
  return {
    commandId: "cmd-maintenance-report-default",
    maintenanceRequestId: seed.authorizedRequestId,
    patrimonyId: seed.validPatrimonyId,
    conclusion: "IRRECUPERAVEL",
    justification: "Laudo emitido para o patrimônio-alvo.",
    issuedAt: new Date("2026-11-11T13:30:00.000Z"),
    actorUserId: seed.globalPatrimonyUserId,
    teamContext: "Patrimonio",
    correlationId: "corr-maintenance-report-default",
    ...overrides
  };
}

type ReportSeed = {
  authorizedRequestId: string;
  unauthorizedRequestId: string;
  validPatrimonyId: string;
  linkedWithoutStrategyPatrimonyId: string;
  globalPatrimonyUserId: string;
  compatibleGrePatrimonyUserId: string;
  unauthorizedActorUserId: string;
};

type ReportRow = {
  id: string;
  version: number;
  conclusion: string;
  justification: string;
  issued_by_user_id: string;
  correlation_id: string;
};

type ReportSnapshot = {
  reports: ReportRow[];
  patrimonyStates: Array<{ id: string; operational_state: string; version: number }>;
  auditCount: number;
  outboxCount: number;
  writeOffCount: number;
  movementCount: number;
};

async function takeSnapshot(client: Client, seed: ReportSeed): Promise<ReportSnapshot> {
  const reports = await client.query<ReportRow>(
    `select "id", "version", "conclusion"::text, "justification", "issued_by_user_id", "correlation_id"
       from "maintenance_request_patrimony_report"
      where "maintenance_request_id" = $1
        and "patrimony_id" = $2
      order by "version"`,
    [seed.authorizedRequestId, seed.validPatrimonyId]
  );
  const patrimonyStates = await client.query<ReportSnapshot["patrimonyStates"][number]>(
    `select "id", "operational_state"::text, "version"
       from "patrimony"
      where "id" in ($1, $2)
      order by "id"`,
    [seed.validPatrimonyId, seed.linkedWithoutStrategyPatrimonyId]
  );
  const effects = await client.query<{
    audit_count: number;
    outbox_count: number;
    write_off_count: number;
    movement_count: number;
  }>(
    `select
       (select count(*)::int from "audit_entry"
         where "action" = 'maintenance.issue_patrimony_report') as "audit_count",
       (select count(*)::int from "outbox_event"
         where "event_type" = 'maintenance.request_patrimony_report_issued') as "outbox_count",
       (select count(*)::int from "patrimony_write_off"
         where "patrimony_id" in ($1, $2)) as "write_off_count",
       (select count(*)::int from "patrimony_movement"
         where "patrimony_id" in ($1, $2)) as "movement_count"`,
    [seed.validPatrimonyId, seed.linkedWithoutStrategyPatrimonyId]
  );

  return {
    reports: reports.rows,
    patrimonyStates: patrimonyStates.rows,
    auditCount: effects.rows[0].audit_count,
    outboxCount: effects.rows[0].outbox_count,
    writeOffCount: effects.rows[0].write_off_count,
    movementCount: effects.rows[0].movement_count
  };
}

async function seedDependencies(client: Client): Promise<ReportSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialId = randomUUID();
  const validPatrimonyId = randomUUID();
  const linkedWithoutStrategyPatrimonyId = randomUUID();
  const authorizedRequestId = randomUUID();
  const unauthorizedRequestId = randomUUID();
  const globalPersonId = randomUUID();
  const compatibleGrePersonId = randomUUID();
  const unauthorizedPersonId = randomUUID();
  const managerPersonId = randomUUID();
  const globalPatrimonyUserId = randomUUID();
  const compatibleGrePatrimonyUserId = randomUUID();
  const unauthorizedActorUserId = randomUUID();
  const managerUserId = randomUUID();
  const patrimonyTeamId = randomUUID();
  const triageTeamId = randomUUID();
  const managementTeamId = randomUUID();
  const greCode = `GRE-RPT-${suffix}`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE de manutenção', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, $2, 'Entidade solicitante', 'ESCOLA', $3, current_timestamp)`,
    [entityId, `ENT-RPT-${suffix}`, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informática', current_timestamp)`,
    [materialClassId, `CLS-RPT-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Equipamento de manutenção', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, `MAT-RPT-${suffix}`, materialClassId]
  );
  await client.query(
    `insert into "patrimony" (
       "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
     ) values
       ($1, $3, $4, 'EM_USO', current_timestamp),
       ($2, $3, $4, 'EM_USO', current_timestamp)`,
    [validPatrimonyId, linkedWithoutStrategyPatrimonyId, materialId, entityId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
       ($1, 'Patrimônio global', current_timestamp),
       ($2, 'Patrimônio GRE', current_timestamp),
       ($3, 'Ator sem autorização', current_timestamp),
       ($4, 'Gerência', current_timestamp)`,
    [globalPersonId, compatibleGrePersonId, unauthorizedPersonId, managerPersonId]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values
       ($1, $2, $3, 'ACTIVE', false, current_timestamp),
       ($4, $5, $6, 'ACTIVE', false, current_timestamp),
       ($7, $8, $9, 'ACTIVE', false, current_timestamp),
       ($10, $11, $12, 'ACTIVE', false, current_timestamp)`,
    [
      globalPatrimonyUserId,
      globalPersonId,
      `patrimonio.report.${suffix.toLowerCase()}@gmap.test`,
      compatibleGrePatrimonyUserId,
      compatibleGrePersonId,
      `patrimonio.gre.report.${suffix.toLowerCase()}@gmap.test`,
      unauthorizedActorUserId,
      unauthorizedPersonId,
      `triagem.report.${suffix.toLowerCase()}@gmap.test`,
      managerUserId,
      managerPersonId,
      `gerencia.report.${suffix.toLowerCase()}@gmap.test`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values
       ($1, 'Patrimônio', current_timestamp),
       ($2, 'Triagem', current_timestamp),
       ($3, 'Gerência', current_timestamp)`,
    [patrimonyTeamId, triageTeamId, managementTeamId]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
     ) values
       ($1, $2, $3, 'MEMBRO', 'GLOBAL', null, true, current_timestamp),
       ($4, $5, $6, 'MEMBRO', 'GRE', $7, true, current_timestamp),
       ($8, $9, $10, 'MEMBRO', 'GLOBAL', null, true, current_timestamp),
       ($11, $12, $13, 'MEMBRO', 'GLOBAL', null, true, current_timestamp)`,
    [
      randomUUID(),
      globalPatrimonyUserId,
      patrimonyTeamId,
      randomUUID(),
      compatibleGrePatrimonyUserId,
      patrimonyTeamId,
      greCode,
      randomUUID(),
      unauthorizedActorUserId,
      triageTeamId,
      randomUUID(),
      managerUserId,
      managementTeamId
    ]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version",
       "correlation_id", "updated_at"
       ) values
         ($1, $3, 'EM_ANALISE', 'Solicitação autorizada', 'Descrição da solicitação',
          '2026-11-11T10:00:00.000Z', '2026-11-11T12:00:00.000Z', $4,
          'Autorização da Gerência', 2, $5, current_timestamp),
         ($2, $3, 'REGISTRADA', 'Solicitação não autorizada', 'Descrição da solicitação',
          '2026-11-11T10:00:00.000Z', null, null, null, 1, $6, current_timestamp)`,
    [
      authorizedRequestId,
      unauthorizedRequestId,
      entityId,
      managerUserId,
      `corr-${authorizedRequestId}`,
      `corr-${unauthorizedRequestId}`
    ]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
       "correlation_id", "updated_at"
     ) values
       ($1, $2, $3, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($6, $2, $7, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($8, $9, $3, '2026-11-11T13:00:00.000Z', $4, $10, current_timestamp)`,
    [
      randomUUID(),
      authorizedRequestId,
      validPatrimonyId,
      globalPatrimonyUserId,
      `corr-target-${authorizedRequestId}`,
      randomUUID(),
      linkedWithoutStrategyPatrimonyId,
      randomUUID(),
      unauthorizedRequestId,
      `corr-target-${unauthorizedRequestId}`
    ]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_strategy" (
       "id", "maintenance_request_id", "patrimony_id", "strategy_type", "justification",
       "defined_at", "defined_by_user_id", "correlation_id", "updated_at"
     ) values
       ($1, $2, $3, 'UTD', 'Atendimento pela unidade técnica descentralizada.',
        '2026-11-11T13:15:00.000Z', $4, $5, current_timestamp),
       ($6, $7, $3, 'UTD', 'Atendimento pela unidade técnica descentralizada.',
        '2026-11-11T13:15:00.000Z', $4, $8, current_timestamp)`,
    [
      randomUUID(),
      authorizedRequestId,
      validPatrimonyId,
      globalPatrimonyUserId,
      `corr-strategy-${authorizedRequestId}`,
      randomUUID(),
      unauthorizedRequestId,
      `corr-strategy-${unauthorizedRequestId}`
    ]
  );

  return {
    authorizedRequestId,
    unauthorizedRequestId,
    validPatrimonyId,
    linkedWithoutStrategyPatrimonyId,
    globalPatrimonyUserId,
    compatibleGrePatrimonyUserId,
    unauthorizedActorUserId
  };
}
