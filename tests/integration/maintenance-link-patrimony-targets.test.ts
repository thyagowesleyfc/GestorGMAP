import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { LinkMaintenanceRequestPatrimonyTargets } from "../../src/modules/maintenance/application/link-maintenance-request-patrimony-targets";
import { PostgresMaintenanceRequestPatrimonyTargetLinker } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-request-patrimony-target-linker";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("link maintenance request patrimony targets", () => {
  it("vincula um ou vários alvos com autorização, escopo, idempotência, concorrência e rollback atômico", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedDependencies(client);
      const useCase = new LinkMaintenanceRequestPatrimonyTargets(
        new PostgresMaintenanceRequestPatrimonyTargetLinker(pool)
      );

      const globalCommand = linkCommand(seed, "cmd-maintenance-link-global-001", [
        seed.firstPatrimonyId
      ]);
      const first = await useCase.execute(globalCommand);
      const retry = await useCase.execute({
        ...globalCommand,
        linkedAt: new Date("2026-11-10T16:01:00.000Z")
      });
      const conflict = await useCase.execute({
        ...globalCommand,
        patrimonyIds: [seed.secondPatrimonyId]
      });

      expect(first).toEqual({
        ok: true,
        maintenanceRequestId: seed.authorizedRequestId,
        status: "EM_ANALISE",
        linkedPatrimonyIds: [seed.firstPatrimonyId],
        linkedCount: 1
      });
      expect(retry).toEqual(first);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });

      const multiple = await useCase.execute(
        linkCommand(seed, "cmd-maintenance-link-multiple-001", [
          seed.secondPatrimonyId,
          seed.thirdPatrimonyId
        ])
      );
      expect(multiple).toEqual({
        ok: true,
        maintenanceRequestId: seed.authorizedRequestId,
        status: "EM_ANALISE",
        linkedPatrimonyIds: [seed.secondPatrimonyId, seed.thirdPatrimonyId],
        linkedCount: 2
      });

      await expect(
        useCase.execute(
          linkCommand(seed, "cmd-maintenance-link-duplicate-001", [seed.firstPatrimonyId])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_ALREADY_LINKED",
        patrimonyId: seed.firstPatrimonyId
      });

      const stateBeforeConcurrent = await snapshot(
        client,
        seed.authorizedRequestId,
        seed.firstPatrimonyId
      );
      const concurrent = await Promise.all([
        useCase.execute(
          linkCommand(seed, "cmd-maintenance-link-concurrent-001", [seed.fourthPatrimonyId])
        ),
        useCase.execute(
          linkCommand(seed, "cmd-maintenance-link-concurrent-002", [seed.fourthPatrimonyId])
        )
      ]);
      expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
      expect(concurrent.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: "PATRIMONY_ALREADY_LINKED", patrimonyId: seed.fourthPatrimonyId }
      ]);
      const stateAfterConcurrent = await snapshot(
        client,
        seed.authorizedRequestId,
        seed.firstPatrimonyId
      );
      expect(stateAfterConcurrent.patrimonyState).toBe(stateBeforeConcurrent.patrimonyState);
      expect(stateAfterConcurrent.patrimonyVersion).toBe(stateBeforeConcurrent.patrimonyVersion);

      const rejectedActors = [
        ["cmd-maintenance-link-manager-001", seed.managerId],
        ["cmd-maintenance-link-triage-001", seed.triageId],
        ["cmd-maintenance-link-technical-001", seed.technicalId],
        ["cmd-maintenance-link-incompatible-gre-001", seed.incompatibleGrePatrimonyUserId]
      ] as const;
      for (const [commandId, actorUserId] of rejectedActors) {
        await expect(
          useCase.execute({
            ...linkCommand(seed, commandId, [seed.unlinkedPatrimonyId]),
            actorUserId
          })
        ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });
      }

      await expect(
        useCase.execute(
          linkCommand(
            seed,
            "cmd-maintenance-link-unauthorized-state-001",
            [seed.unlinkedPatrimonyId],
            seed.registeredRequestId
          )
        )
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: seed.registeredRequestId
      });

      const beforeRollback = await snapshot(
        client,
        seed.authorizedRequestId,
        seed.firstPatrimonyId
      );
      await expect(
        useCase.execute(
          linkCommand(seed, "cmd-maintenance-link-rollback-001", [
            seed.unlinkedPatrimonyId,
            randomUUID()
          ])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_NOT_FOUND",
        patrimonyId: expect.any(String)
      });
      const afterRollback = await snapshot(client, seed.authorizedRequestId, seed.firstPatrimonyId);
      expect(afterRollback).toEqual(beforeRollback);

      const effects = await client.query(
        `select
           (select count(*)::int from "maintenance_request_patrimony_target" where "maintenance_request_id" = $1) as targets,
           (select count(*)::int from "audit_entry" where "object_id" = $1::text and "action" = 'maintenance.link_patrimony_targets') as audits,
           (select count(*)::int from "outbox_event" where "aggregate_id" = $1::text and "event_type" = 'maintenance.request_patrimony_targets_linked') as outbox,
           (select count(*)::int from "command_idempotency" where "command_name" = 'maintenance.link_patrimony_targets') as idempotency`,
        [seed.authorizedRequestId]
      );
      expect(effects.rows).toEqual([{ targets: 4, audits: 3, outbox: 3, idempotency: 11 }]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 180000);
});

function linkCommand(
  seed: MaintenanceTargetSeed,
  commandId: string,
  patrimonyIds: string[],
  maintenanceRequestId = seed.authorizedRequestId,
  actorUserId = seed.globalPatrimonyUserId
) {
  return {
    commandId,
    maintenanceRequestId,
    patrimonyIds,
    linkedAt: new Date("2026-11-10T16:00:00.000Z"),
    actorUserId,
    teamContext: "Patrimônio",
    correlationId: `${commandId}-correlation`
  };
}

async function snapshot(client: Client, requestId: string, patrimonyId: string) {
  const result = await client.query(
    `select
       (select "version" from "maintenance_request" where "id" = $1) as "requestVersion",
       (select count(*)::int from "maintenance_request_patrimony_target" where "maintenance_request_id" = $1) as "targetCount",
       (select "operational_state"::text from "patrimony" where "id" = $2) as "patrimonyState",
       (select "version" from "patrimony" where "id" = $2) as "patrimonyVersion"`,
    [requestId, patrimonyId]
  );
  return result.rows[0];
}

type MaintenanceTargetSeed = {
  authorizedRequestId: string;
  registeredRequestId: string;
  firstPatrimonyId: string;
  secondPatrimonyId: string;
  thirdPatrimonyId: string;
  fourthPatrimonyId: string;
  unlinkedPatrimonyId: string;
  globalPatrimonyUserId: string;
  incompatibleGrePatrimonyUserId: string;
  managerId: string;
  triageId: string;
  technicalId: string;
};

async function seedDependencies(client: Client): Promise<MaintenanceTargetSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const loginSuffix = suffix.toLowerCase();
  const compatibleGreId = randomUUID();
  const incompatibleGreId = randomUUID();
  const entityId = randomUUID();
  const otherEntityId = randomUUID();
  const materialClassId = randomUUID();
  const materialId = randomUUID();
  const teamId = randomUUID();
  const triageTeamId = randomUUID();
  const managerTeamId = randomUUID();
  const compatibleGre = `GRE-MNT-${suffix}`;
  const incompatibleGre = `GRE-OUT-${suffix}`;
  const globalPatrimonyUserId = randomUUID();
  const compatibleGrePatrimonyUserId = randomUUID();
  const incompatibleGrePatrimonyUserId = randomUUID();
  const managerId = randomUUID();
  const triageId = randomUUID();
  const technicalId = randomUUID();
  const persons = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ];
  const patrimonyIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const authorizedRequestId = randomUUID();
  const registeredRequestId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
      ($1, $2, 'GRE Manutenção', current_timestamp), ($3, $4, 'GRE Externa', current_timestamp)`,
    [compatibleGreId, compatibleGre, incompatibleGreId, incompatibleGre]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at") values
      ($1, $2, 'Entidade solicitante', 'ESCOLA', $3, current_timestamp),
      ($4, $5, 'Entidade externa', 'ESCOLA', $6, current_timestamp)`,
    [
      entityId,
      `ENT-MNT-${suffix}`,
      compatibleGreId,
      otherEntityId,
      `ENT-OUT-${suffix}`,
      incompatibleGreId
    ]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at") values ($1, $2, 'Informática', current_timestamp)`,
    [materialClassId, `CLASSE-MNT-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" ("id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at")
     values ($1, $2, 'Computador de teste', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, `MAT-MNT-${suffix}`, materialClassId]
  );
  for (const patrimonyId of patrimonyIds.slice(0, 4)) {
    await client.query(
      `insert into "patrimony" ("id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at")
       values ($1, $2, $3, 'EM_USO', current_timestamp)`,
      [patrimonyId, materialId, entityId]
    );
  }
  await client.query(
    `insert into "patrimony" ("id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at")
     values ($1, $2, $3, 'EM_USO', current_timestamp)`,
    [patrimonyIds[4], materialId, otherEntityId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
      ($1, 'Patrimônio Global', current_timestamp), ($2, 'Patrimônio GRE', current_timestamp),
      ($3, 'Patrimônio GRE incompatível', current_timestamp), ($4, 'Gerência', current_timestamp),
      ($5, 'Triagem', current_timestamp), ($6, 'Superusuário técnico', current_timestamp)`,
    persons
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at") values
      ($1, $2, $3, 'ACTIVE', false, current_timestamp), ($4, $5, $6, 'ACTIVE', false, current_timestamp),
      ($7, $8, $9, 'ACTIVE', false, current_timestamp), ($10, $11, $12, 'ACTIVE', false, current_timestamp),
      ($13, $14, $15, 'ACTIVE', false, current_timestamp), ($16, $17, $18, 'ACTIVE', true, current_timestamp)`,
    [
      globalPatrimonyUserId,
      persons[0],
      `patrimonio.global.${loginSuffix}@gmap.test`,
      compatibleGrePatrimonyUserId,
      persons[1],
      `patrimonio.gre.${loginSuffix}@gmap.test`,
      incompatibleGrePatrimonyUserId,
      persons[2],
      `patrimonio.out.${loginSuffix}@gmap.test`,
      managerId,
      persons[3],
      `gerencia.${loginSuffix}@gmap.test`,
      triageId,
      persons[4],
      `triagem.${loginSuffix}@gmap.test`,
      technicalId,
      persons[5],
      `technical.${loginSuffix}@gmap.test`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values
      ($1, 'Patrimônio', current_timestamp), ($2, 'Gerência', current_timestamp), ($3, 'Triagem', current_timestamp)`,
    [teamId, managerTeamId, triageTeamId]
  );
  await client.query(
    `insert into "team_membership" ("id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at") values
      ($1, $2, $3, 'MEMBRO', 'GLOBAL', null, current_timestamp),
      ($4, $5, $3, 'MEMBRO', 'GRE', $6, current_timestamp),
      ($7, $8, $3, 'MEMBRO', 'GRE', $9, current_timestamp),
      ($10, $11, $12, 'MEMBRO', 'GLOBAL', null, current_timestamp),
      ($13, $14, $15, 'MEMBRO', 'GRE', $6, current_timestamp)`,
    [
      randomUUID(),
      globalPatrimonyUserId,
      teamId,
      randomUUID(),
      compatibleGrePatrimonyUserId,
      compatibleGre,
      randomUUID(),
      incompatibleGrePatrimonyUserId,
      compatibleGre,
      randomUUID(),
      managerId,
      managerTeamId,
      randomUUID(),
      triageId,
      triageTeamId
    ]
  );
  await client.query(
    `insert into "maintenance_request" ("id", "requesting_entity_id", "status", "summary", "description", "requested_at", "authorized_at", "authorized_by_user_id", "authorization_reason", "version", "correlation_id", "updated_at") values
      ($1, $3, 'EM_ANALISE', 'Solicitação autorizada', 'Descrição', '2026-11-10T10:00:00.000Z', '2026-11-10T12:00:00.000Z', $4, 'Autorização da Gerência', 2, $5, current_timestamp),
      ($2, $3, 'REGISTRADA', 'Solicitação registrada', 'Descrição', '2026-11-10T10:00:00.000Z', null, null, null, 1, $6, current_timestamp)`,
    [
      authorizedRequestId,
      registeredRequestId,
      entityId,
      managerId,
      `corr-${authorizedRequestId}`,
      `corr-${registeredRequestId}`
    ]
  );

  return {
    authorizedRequestId,
    registeredRequestId,
    firstPatrimonyId: patrimonyIds[0],
    secondPatrimonyId: patrimonyIds[1],
    thirdPatrimonyId: patrimonyIds[2],
    fourthPatrimonyId: patrimonyIds[3],
    unlinkedPatrimonyId: patrimonyIds[4],
    globalPatrimonyUserId,
    incompatibleGrePatrimonyUserId,
    managerId,
    triageId,
    technicalId
  };
}
