import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AuthorizeMaintenanceRequest } from "../../src/modules/maintenance/application/authorize-maintenance-request";
import { PostgresMaintenanceRequestAuthorizer } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-request-authorizer";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("authorize maintenance request", () => {
  it("autoriza com escopo GLOBAL e persiste o fato, auditoria, Outbox e idempotência", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedMaintenanceAuthorizationDependencies(client);
      const useCase = createUseCase(pool);
      const command = authorizationCommand(seed, "cmd-maintenance-authorize-global-001");

      const first = await useCase.execute(command);
      const retry = await useCase.execute(command);

      expect(first).toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE"
      });
      expect(retry).toEqual(first);
      await expectAuthorizedRequest(client, seed.requestId, seed.globalManagerId, command.reason);
      await expectEffects(client, seed.requestId, 1);
      await expectNoPatrimonyTargetOrStrategyEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("aceita GRE compatível e rejeita GRE incompatível, Triagem e superusuário técnico", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedMaintenanceAuthorizationDependencies(client);
      const useCase = createUseCase(pool);

      await expect(
        useCase.execute(
          authorizationCommand(
            seed,
            "cmd-maintenance-authorize-gre-compatible-001",
            seed.greManagerId
          )
        )
      ).resolves.toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE"
      });

      const second = await seedMaintenanceRequest(
        client,
        seed.compatibleGreCode,
        undefined,
        seed.entityId
      );
      await expect(
        useCase.execute({
          ...authorizationCommand(
            seed,
            "cmd-maintenance-authorize-gre-incompatible-001",
            seed.incompatibleGreManagerId
          ),
          maintenanceRequestId: second
        })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });
      await expect(
        useCase.execute({
          ...authorizationCommand(seed, "cmd-maintenance-authorize-triage-001", seed.triageUserId),
          maintenanceRequestId: second
        })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });
      await expect(
        useCase.execute({
          ...authorizationCommand(
            seed,
            "cmd-maintenance-authorize-superuser-001",
            seed.technicalUserId
          ),
          maintenanceRequestId: second
        })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });
      await expectRequestUnchanged(client, second);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("rejeita solicitação inexistente, estado diferente de REGISTRADA e conflito de idempotência", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedMaintenanceAuthorizationDependencies(client);
      const otherRequestId = await seedMaintenanceRequest(
        client,
        seed.compatibleGreCode,
        undefined,
        seed.entityId
      );
      const useCase = createUseCase(pool);
      const command = authorizationCommand(seed, "cmd-maintenance-authorize-conflict-001");

      await expect(useCase.execute(command)).resolves.toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE"
      });
      await expect(
        useCase.execute({ ...command, maintenanceRequestId: otherRequestId })
      ).resolves.toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expect(
        useCase.execute({
          ...authorizationCommand(seed, "cmd-maintenance-authorize-missing-001"),
          maintenanceRequestId: randomUUID()
        })
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_FOUND",
        maintenanceRequestId: expect.any(String)
      });

      await client.query(
        `update "maintenance_request" set "status" = 'EM_ANALISE' where "id" = $1`,
        [otherRequestId]
      );
      await expect(
        useCase.execute({
          ...authorizationCommand(seed, "cmd-maintenance-authorize-state-001"),
          maintenanceRequestId: otherRequestId
        })
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_REGISTRADA",
        maintenanceRequestId: otherRequestId
      });
      await expectEffects(client, otherRequestId, 0, 3);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("serializa duas autorizações concorrentes para a mesma solicitação", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedMaintenanceAuthorizationDependencies(client);
      const useCase = createUseCase(pool);
      const common = authorizationCommand(seed, "cmd-maintenance-authorize-concurrent-001");
      const results = await Promise.all([
        useCase.execute(common),
        useCase.execute({ ...common, commandId: "cmd-maintenance-authorize-concurrent-002" })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "MAINTENANCE_REQUEST_NOT_REGISTRADA",
          maintenanceRequestId: seed.requestId
        }
      ]);
      await expectAuthorizedRequest(client, seed.requestId, seed.globalManagerId, common.reason);
      await expectEffects(client, seed.requestId, 1, 2);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

function createUseCase(pool: Pool): AuthorizeMaintenanceRequest {
  return new AuthorizeMaintenanceRequest(new PostgresMaintenanceRequestAuthorizer(pool));
}

function authorizationCommand(
  seed: MaintenanceAuthorizationSeed,
  commandId: string,
  actorUserId = seed.globalManagerId
) {
  return {
    commandId,
    maintenanceRequestId: seed.requestId,
    authorizedAt: new Date("2026-11-10T15:00:00.000Z"),
    reason: "Autorização da Gerência para prosseguir com a análise técnica.",
    actorUserId,
    teamContext: "Gerência",
    correlationId: `${commandId}-correlation`
  };
}

async function expectAuthorizedRequest(
  client: Client,
  requestId: string,
  managerId: string,
  reason: string
): Promise<void> {
  const result = await client.query(
    `select "status"::text, "authorized_at", "authorized_by_user_id", "authorization_reason", "version"
       from "maintenance_request" where "id" = $1`,
    [requestId]
  );

  expect(result.rows).toEqual([
    {
      status: "EM_ANALISE",
      authorized_at: expect.any(Date),
      authorized_by_user_id: managerId,
      authorization_reason: reason,
      version: 2
    }
  ]);
}

async function expectRequestUnchanged(client: Client, requestId: string): Promise<void> {
  const result = await client.query(
    `select "status"::text, "authorized_at", "authorized_by_user_id", "authorization_reason", "version"
       from "maintenance_request" where "id" = $1`,
    [requestId]
  );

  expect(result.rows).toEqual([
    {
      status: "REGISTRADA",
      authorized_at: null,
      authorized_by_user_id: null,
      authorization_reason: null,
      version: 1
    }
  ]);
}

async function expectEffects(
  client: Client,
  requestId: string,
  expectedCount: number,
  expectedIdempotencyCount = expectedCount
): Promise<void> {
  const result = await client.query(
    `select
       (select count(*)::int from "audit_entry" where "object_id" = $1 and "action" = 'maintenance.authorize_request') as audits,
       (select count(*)::int from "outbox_event" where "aggregate_id" = $1 and "event_type" = 'maintenance.request_authorized') as outbox,
       (select count(*)::int from "command_idempotency" where "command_name" = 'maintenance.authorize_request') as idempotency`,
    [requestId]
  );

  expect(result.rows).toEqual([
    { audits: expectedCount, outbox: expectedCount, idempotency: expectedIdempotencyCount }
  ]);
}

async function expectNoPatrimonyTargetOrStrategyEffects(client: Client): Promise<void> {
  const result = await client.query<{ patrimonies: number }>(
    `select count(*)::int as patrimonies from "patrimony"`
  );

  expect(result.rows).toEqual([{ patrimonies: 0 }]);
}

type MaintenanceAuthorizationSeed = {
  requestId: string;
  entityId: string;
  compatibleGreCode: string;
  globalManagerId: string;
  greManagerId: string;
  incompatibleGreManagerId: string;
  triageUserId: string;
  technicalUserId: string;
};

async function seedMaintenanceAuthorizationDependencies(
  client: Client
): Promise<MaintenanceAuthorizationSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const loginSuffix = suffix.toLowerCase();
  const compatibleGreCode = `GRE-MA-${suffix}`;
  const incompatibleGreCode = `GRE-OUT-${suffix}`;
  const compatibleGreId = randomUUID();
  const incompatibleGreId = randomUUID();
  const entityId = randomUUID();
  const requestId = randomUUID();
  const teamId = randomUUID();
  const triageTeamId = randomUUID();
  const globalManagerId = randomUUID();
  const greManagerId = randomUUID();
  const incompatibleGreManagerId = randomUUID();
  const triageUserId = randomUUID();
  const technicalUserId = randomUUID();
  const personIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
      ($1, $2, 'GRE Manutenção', current_timestamp), ($3, $4, 'GRE Externa', current_timestamp)`,
    [compatibleGreId, compatibleGreCode, incompatibleGreId, incompatibleGreCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, $2, 'Entidade solicitante', 'ESCOLA', $3, current_timestamp)`,
    [entityId, `ENT-MA-${suffix}`, compatibleGreId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
      ($1, 'Gerência Global', current_timestamp), ($2, 'Gerência GRE', current_timestamp),
      ($3, 'Gerência GRE incompatível', current_timestamp), ($4, 'Triagem', current_timestamp),
      ($5, 'Superusuário técnico', current_timestamp)`,
    personIds
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at") values
      ($1, $2, $3, 'ACTIVE', false, current_timestamp), ($4, $5, $6, 'ACTIVE', false, current_timestamp),
      ($7, $8, $9, 'ACTIVE', false, current_timestamp), ($10, $11, $12, 'ACTIVE', false, current_timestamp),
      ($13, $14, $15, 'ACTIVE', true, current_timestamp)`,
    [
      globalManagerId,
      personIds[0],
      `global-${loginSuffix}@gmap.test`,
      greManagerId,
      personIds[1],
      `gre-${loginSuffix}@gmap.test`,
      incompatibleGreManagerId,
      personIds[2],
      `gre-out-${loginSuffix}@gmap.test`,
      triageUserId,
      personIds[3],
      `triage-${loginSuffix}@gmap.test`,
      technicalUserId,
      personIds[4],
      `technical-${loginSuffix}@gmap.test`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values ($1, 'Gerência', current_timestamp), ($2, 'Triagem', current_timestamp)`,
    [teamId, triageTeamId]
  );
  await client.query(
    `insert into "team_membership" ("id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at") values
      ($1, $2, $3, 'MEMBRO', 'GLOBAL', null, current_timestamp),
      ($4, $5, $3, 'MEMBRO', 'GRE', $6, current_timestamp),
      ($7, $8, $3, 'MEMBRO', 'GRE', $9, current_timestamp),
      ($10, $11, $12, 'MEMBRO', 'GRE', $6, current_timestamp)`,
    [
      randomUUID(),
      globalManagerId,
      teamId,
      randomUUID(),
      greManagerId,
      compatibleGreCode,
      randomUUID(),
      incompatibleGreManagerId,
      incompatibleGreCode,
      randomUUID(),
      triageUserId,
      triageTeamId
    ]
  );
  await seedMaintenanceRequest(client, compatibleGreCode, requestId, entityId);

  return {
    requestId,
    entityId,
    compatibleGreCode,
    globalManagerId,
    greManagerId,
    incompatibleGreManagerId,
    triageUserId,
    technicalUserId
  };
}

async function seedMaintenanceRequest(
  client: Client,
  greCode: string,
  requestId = randomUUID(),
  entityId?: string
): Promise<string> {
  const id = entityId ?? randomUUID();
  if (entityId === undefined) {
    const greId = randomUUID();
    await client.query(
      `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, 'GRE adicional', current_timestamp)`,
      [greId, greCode]
    );
    await client.query(
      `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at") values ($1, $2, 'Entidade adicional', 'ESCOLA', $3, current_timestamp)`,
      [id, `ENT-${randomUUID().slice(0, 8)}`, greId]
    );
  }
  await client.query(
    `insert into "maintenance_request" ("id", "requesting_entity_id", "status", "summary", "description", "requested_at", "version", "correlation_id", "updated_at")
     values ($1, $2, 'REGISTRADA', 'Solicitação de manutenção', 'Descrição da solicitação', '2026-11-10T10:00:00.000Z', 1, $3, current_timestamp)`,
    [requestId, id, `corr-${requestId}`]
  );
  return requestId;
}
