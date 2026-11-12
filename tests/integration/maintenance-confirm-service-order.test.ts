import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ConfirmMaintenanceServiceOrderInput } from "../../src/modules/maintenance/application/confirm-maintenance-service-order";
import { ConfirmMaintenanceServiceOrder } from "../../src/modules/maintenance/application/confirm-maintenance-service-order";
import { PostgresMaintenanceServiceOrderConfirmer } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-confirmer";

const execFileAsync = promisify(execFile);
const CONFIRM_SERVICE_ORDER_COMMAND = "maintenance.confirm_service_order_entity";
const SERVICE_ORDER_ENTITY_CONFIRMED_EVENT = "maintenance.service_order_entity_confirmed";

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("confirmação funcional da Entidade na Ordem de Serviço", () => {
  it("persiste o fato com auditoria, Outbox, idempotência e não altera o status da OS", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 8 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = createUseCase(pool);
      const command = confirmCommand(seed);
      const before = await takeSnapshot(client, seed.validServiceOrderId);

      const result = await useCase.execute(command);

      expect(result).toMatchObject({
        ok: true,
        serviceOrderId: seed.validServiceOrderId,
        status: "EXECUTADA"
      });
      if (!result.ok) {
        throw new Error("A confirmação deveria ser concluída.");
      }

      const after = await takeSnapshot(client, seed.validServiceOrderId);
      expect(after.status).toBe("EXECUTADA");
      expect(after.entityId).toBe(seed.entityId);
      expect(after.confirmations).toHaveLength(1);
      expect(after.confirmations[0]).toMatchObject({
        service_order_id: seed.validServiceOrderId,
        entity_id: seed.entityId,
        evidence_reference: command.evidenceReference,
        registered_by_user_id: command.actorUserId,
        correlation_id: command.correlationId
      });
      expect(after.confirmations[0]?.confirmed_at.toISOString()).toBe(
        command.confirmedAt?.toISOString()
      );
      expect(after.auditCount).toBe(before.auditCount + 1);
      expect(after.outboxCount).toBe(before.outboxCount + 1);
      await expectAuditAndOutboxOnce(
        client,
        seed.validServiceOrderId,
        command,
        result.confirmationId
      );

      await expect(useCase.execute(command)).resolves.toEqual(result);
      await expect(
        useCase.execute({
          ...command,
          evidenceReference: "evidencia-divergente"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "IDEMPOTENCY_KEY_CONFLICT"
      });
      expect(await takeSnapshot(client, seed.validServiceOrderId)).toEqual(after);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);

  it("protege a confirmação contra concorrência, escopo incompatível e status inválido", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 8 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = createUseCase(pool);
      const firstCommand = confirmCommand(seed, {
        commandId: "cmd-maintenance-confirm-service-order-concurrent-001",
        correlationId: "corr-maintenance-confirm-service-order-concurrent-001",
        evidenceReference: "termo-concorrente-1"
      });
      const secondCommand = confirmCommand(seed, {
        commandId: "cmd-maintenance-confirm-service-order-concurrent-002",
        correlationId: "corr-maintenance-confirm-service-order-concurrent-002",
        evidenceReference: "termo-concorrente-2"
      });

      const [firstResult, secondResult] = await Promise.all([
        useCase.execute(firstCommand),
        useCase.execute(secondCommand)
      ]);
      const results = [firstResult, secondResult];

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "SERVICE_ORDER_ALREADY_CONFIRMED",
          serviceOrderId: seed.validServiceOrderId
        }
      ]);
      expect(
        (
          await client.query<{ count: number }>(
            `select count(*)::int as "count"
             from "maintenance_service_order_entity_confirmation"
            where "service_order_id" = $1`,
            [seed.validServiceOrderId]
          )
        ).rows[0]?.count
      ).toBe(1);

      await expect(
        useCase.execute(
          confirmCommand(seed, {
            commandId: "cmd-maintenance-confirm-service-order-unauthorized-001",
            serviceOrderId: seed.unauthorizedServiceOrderId,
            actorUserId: seed.incompatibleScopeUserId,
            correlationId: "corr-maintenance-confirm-service-order-unauthorized-001"
          })
        )
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        serviceOrderId: seed.unauthorizedServiceOrderId
      });
      await expectNoEffects(client, seed.unauthorizedServiceOrderId);

      await expect(
        useCase.execute(
          confirmCommand(seed, {
            commandId: "cmd-maintenance-confirm-service-order-invalid-status-001",
            serviceOrderId: seed.invalidStatusServiceOrderId,
            correlationId: "corr-maintenance-confirm-service-order-invalid-status-001"
          })
        )
      ).resolves.toEqual({
        ok: false,
        reason: "SERVICE_ORDER_NOT_CONFIRMABLE",
        serviceOrderId: seed.invalidStatusServiceOrderId
      });
      await expectNoEffects(client, seed.invalidStatusServiceOrderId);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);
});

type ServiceOrderSeed = {
  suffix: string;
  validServiceOrderId: string;
  unauthorizedServiceOrderId: string;
  invalidStatusServiceOrderId: string;
  requestId: string;
  authorizedUserId: string;
  incompatibleScopeUserId: string;
  entityId: string;
  greOneCode: string;
};

type ConfirmCommandOverrides = Partial<ConfirmMaintenanceServiceOrderInput>;

function createUseCase(pool: Pool): ConfirmMaintenanceServiceOrder {
  return new ConfirmMaintenanceServiceOrder(new PostgresMaintenanceServiceOrderConfirmer(pool));
}

function confirmCommand(
  seed: ServiceOrderSeed,
  overrides: ConfirmCommandOverrides = {}
): ConfirmMaintenanceServiceOrderInput {
  return {
    commandId: "cmd-maintenance-confirm-service-order-valid-001",
    serviceOrderId: seed.validServiceOrderId,
    evidenceReference: "termo-de-confirmacao-entidade-001",
    confirmedAt: new Date("2026-11-12T16:00:00.000Z"),
    actorUserId: seed.authorizedUserId,
    teamContext: "Patrimônio",
    correlationId: "corr-maintenance-confirm-service-order-valid-001",
    ...overrides
  };
}

type Snapshot = {
  status: string;
  entityId: string;
  confirmations: Array<{
    service_order_id: string;
    entity_id: string;
    confirmed_at: Date;
    evidence_reference: string;
    registered_by_user_id: string;
    correlation_id: string;
  }>;
  auditCount: number;
  outboxCount: number;
};

async function takeSnapshot(client: Client, serviceOrderId: string): Promise<Snapshot> {
  const serviceOrder = await client.query<{ status: string; entity_id: string }>(
    `select "status"::text as "status", "entity_id"
       from "maintenance_service_order"
      where "id" = $1`,
    [serviceOrderId]
  );
  const serviceOrderRow = serviceOrder.rows[0];
  if (serviceOrderRow === undefined) {
    throw new Error(`OS ${serviceOrderId} não encontrada ao coletar o snapshot.`);
  }

  const confirmations = await client.query<Snapshot["confirmations"][number]>(
    `select "service_order_id", "entity_id", "confirmed_at", "evidence_reference",
            "registered_by_user_id", "correlation_id"
       from "maintenance_service_order_entity_confirmation"
      where "service_order_id" = $1`,
    [serviceOrderId]
  );
  const audit = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "action" = $1
        and "next_value"->>'serviceOrderId' = $2`,
    [CONFIRM_SERVICE_ORDER_COMMAND, serviceOrderId]
  );
  const outbox = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ENTITY_CONFIRMED_EVENT, serviceOrderId]
  );

  return {
    status: serviceOrderRow.status,
    entityId: serviceOrderRow.entity_id,
    confirmations: confirmations.rows,
    auditCount: audit.rows[0]?.count ?? 0,
    outboxCount: outbox.rows[0]?.count ?? 0
  };
}

async function expectAuditAndOutboxOnce(
  client: Client,
  serviceOrderId: string,
  command: ConfirmMaintenanceServiceOrderInput,
  confirmationId: string
): Promise<void> {
  const audit = await client.query<{
    action: string;
    object_type: string;
    object_id: string;
    actor_user_id: string;
    team_context: string;
    correlation_id: string;
    next_value: {
      confirmationId?: string;
      serviceOrderId?: string;
      entityId?: string;
      evidenceReference?: string;
      confirmedAt?: string;
      registeredByUserId?: string;
      correlationId?: string;
    };
  }>(
    `select "action", "object_type", "object_id", "actor_user_id", "team_context",
            "correlation_id", "next_value"
       from "audit_entry"
      where "action" = $1
        and "object_type" = 'maintenance_service_order_entity_confirmation'
        and "object_id" = $2`,
    [CONFIRM_SERVICE_ORDER_COMMAND, confirmationId]
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    action: CONFIRM_SERVICE_ORDER_COMMAND,
    object_type: "maintenance_service_order_entity_confirmation",
    object_id: confirmationId,
    actor_user_id: command.actorUserId,
    team_context: command.teamContext,
    correlation_id: command.correlationId,
    next_value: {
      confirmationId,
      serviceOrderId,
      entityId: expect.any(String),
      evidenceReference: command.evidenceReference,
      confirmedAt: command.confirmedAt?.toISOString(),
      registeredByUserId: command.actorUserId,
      correlationId: command.correlationId
    }
  });

  const outbox = await client.query<{
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: {
      confirmationId?: string;
      serviceOrderId?: string;
      entityId?: string;
      evidenceReference?: string;
      confirmedAt?: string;
      registeredByUserId?: string;
      correlationId?: string;
    };
  }>(
    `select "event_type", "aggregate_type", "aggregate_id", "payload"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ENTITY_CONFIRMED_EVENT, serviceOrderId]
  );
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0]).toMatchObject({
    event_type: SERVICE_ORDER_ENTITY_CONFIRMED_EVENT,
    aggregate_type: "maintenance_service_order",
    aggregate_id: serviceOrderId,
    payload: {
      confirmationId,
      serviceOrderId,
      entityId: expect.any(String),
      evidenceReference: command.evidenceReference,
      confirmedAt: command.confirmedAt?.toISOString(),
      registeredByUserId: command.actorUserId,
      correlationId: command.correlationId
    }
  });
}

async function expectNoEffects(client: Client, serviceOrderId: string): Promise<void> {
  const confirmation = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "maintenance_service_order_entity_confirmation"
      where "service_order_id" = $1`,
    [serviceOrderId]
  );
  const audit = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "action" = $1
        and "next_value"->>'serviceOrderId' = $2`,
    [CONFIRM_SERVICE_ORDER_COMMAND, serviceOrderId]
  );
  const outbox = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ENTITY_CONFIRMED_EVENT, serviceOrderId]
  );

  expect(confirmation.rows[0]?.count).toBe(0);
  expect(audit.rows[0]?.count).toBe(0);
  expect(outbox.rows[0]?.count).toBe(0);
}

async function seedDependencies(client: Client): Promise<ServiceOrderSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const ids = {
    greOne: randomUUID(),
    greTwo: randomUUID(),
    entityOne: randomUUID(),
    personAuthorized: randomUUID(),
    personIncompatible: randomUUID(),
    authorizedUser: randomUUID(),
    incompatibleScopeUser: randomUUID(),
    patrimonyTeam: randomUUID(),
    supplier: randomUUID(),
    contract: randomUUID(),
    request: randomUUID(),
    validServiceOrder: randomUUID(),
    unauthorizedServiceOrder: randomUUID(),
    invalidStatusServiceOrder: randomUUID()
  };
  const greOneCode = `GRE-CONFIRM-${suffix}-A`;
  const greTwoCode = `GRE-CONFIRM-${suffix}-B`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
      ($1, $2, 'GRE de confirmação A', current_timestamp),
      ($3, $4, 'GRE de confirmação B', current_timestamp)`,
    [ids.greOne, greOneCode, ids.greTwo, greTwoCode]
  );
  await client.query(
    `insert into "entity" (
       "id", "code", "name", "entity_type", "gre_id", "updated_at"
     ) values ($1, $2, 'Entidade de confirmação', 'ESCOLA', $3, current_timestamp)`,
    [ids.entityOne, `ENT-CONFIRM-${suffix}`, ids.greOne]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
      ($1, 'Operador autorizado de confirmação', current_timestamp),
      ($2, 'Operador fora do escopo da confirmação', current_timestamp)`,
    [ids.personAuthorized, ids.personIncompatible]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values
       ($1, $2, $3, 'ACTIVE', false, current_timestamp),
       ($4, $5, $6, 'ACTIVE', false, current_timestamp)`,
    [
      ids.authorizedUser,
      ids.personAuthorized,
      `authorized.confirm.${suffix.toLowerCase()}@gmap.test`,
      ids.incompatibleScopeUser,
      ids.personIncompatible,
      `incompatible.confirm.${suffix.toLowerCase()}@gmap.test`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Patrimônio', current_timestamp)`,
    [ids.patrimonyTeam]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
     ) values
       ($1, $2, $3, 'MEMBRO', 'GLOBAL', null, true, current_timestamp),
       ($4, $5, $3, 'MEMBRO', 'GRE', $6, true, current_timestamp)`,
    [
      randomUUID(),
      ids.authorizedUser,
      ids.patrimonyTeam,
      randomUUID(),
      ids.incompatibleScopeUser,
      greTwoCode
    ]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de confirmação', current_timestamp)`,
    [ids.supplier, `FORN-CONFIRM-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de serviço para confirmação', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-CONFIRM-${suffix}`, ids.supplier]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version",
       "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitação de confirmação', 'Descrição de teste', $3,
       $3, $4, 'Autorização para teste de confirmação', 1, $5, current_timestamp)`,
    [
      ids.request,
      ids.entityOne,
      new Date("2026-11-12T12:00:00.000Z"),
      ids.authorizedUser,
      `corr-maintenance-request-confirm-${suffix}`
    ]
  );

  await insertServiceOrder(client, {
    id: ids.validServiceOrder,
    code: `OS-CONFIRM-${suffix}-VALID`,
    requestId: ids.request,
    contractId: ids.contract,
    entityId: ids.entityOne,
    status: "EXECUTADA",
    issuedByUserId: ids.authorizedUser,
    correlationId: `corr-maintenance-service-order-confirm-${suffix}-valid`
  });
  await insertServiceOrder(client, {
    id: ids.unauthorizedServiceOrder,
    code: `OS-CONFIRM-${suffix}-UNAUTHORIZED`,
    requestId: ids.request,
    contractId: ids.contract,
    entityId: ids.entityOne,
    status: "EXECUTADA",
    issuedByUserId: ids.authorizedUser,
    correlationId: `corr-maintenance-service-order-confirm-${suffix}-unauthorized`
  });
  await insertServiceOrder(client, {
    id: ids.invalidStatusServiceOrder,
    code: `OS-CONFIRM-${suffix}-INVALID-STATUS`,
    requestId: ids.request,
    contractId: ids.contract,
    entityId: ids.entityOne,
    status: "ENVIADA_AO_PRESTADOR",
    issuedByUserId: ids.authorizedUser,
    correlationId: `corr-maintenance-service-order-confirm-${suffix}-invalid-status`
  });

  return {
    suffix,
    validServiceOrderId: ids.validServiceOrder,
    unauthorizedServiceOrderId: ids.unauthorizedServiceOrder,
    invalidStatusServiceOrderId: ids.invalidStatusServiceOrder,
    requestId: ids.request,
    authorizedUserId: ids.authorizedUser,
    incompatibleScopeUserId: ids.incompatibleScopeUser,
    entityId: ids.entityOne,
    greOneCode
  };
}

async function insertServiceOrder(
  client: Client,
  input: {
    id: string;
    code: string;
    requestId: string;
    contractId: string;
    entityId: string;
    status: "EXECUTADA" | "ENVIADA_AO_PRESTADOR";
    issuedByUserId: string;
    correlationId: string;
  }
): Promise<void> {
  await client.query(
    `insert into "maintenance_service_order" (
       "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
       "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
    [
      input.id,
      input.code,
      input.requestId,
      input.contractId,
      input.entityId,
      input.status,
      new Date("2026-11-12T13:00:00.000Z"),
      input.issuedByUserId,
      input.correlationId
    ]
  );
}
