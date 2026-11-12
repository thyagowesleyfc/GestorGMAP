import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { AttestMaintenanceServiceOrderInput } from "../../src/modules/maintenance/application/attest-maintenance-service-order";
import { AttestMaintenanceServiceOrder } from "../../src/modules/maintenance/application/attest-maintenance-service-order";
import { PostgresMaintenanceServiceOrderAttester } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-attester";

const execFileAsync = promisify(execFile);
const ATTEST_SERVICE_ORDER_ACTION = "maintenance.attest_service_order";
const SERVICE_ORDER_ATTESTED_EVENT = "maintenance.service_order_attested";

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("registro do ateste de Ordem de Serviço de manutenção", () => {
  it("atesta uma OS executada com lock, autorização por todos os GREs, idempotência e efeitos atômicos", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 8 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      await alignPartialAuthorizationWithFirstTarget(client, seed);

      const useCase = new AttestMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderAttester(pool)
      );
      const firstCommand = attestCommand(seed, {
        commandId: "cmd-maintenance-attest-service-order-first-001",
        attestedAt: new Date("2026-11-12T16:00:00.000Z"),
        correlationId: "corr-maintenance-attest-service-order-first-001"
      });
      const secondCommand = attestCommand(seed, {
        commandId: "cmd-maintenance-attest-service-order-second-001",
        attestedAt: new Date("2026-11-12T16:01:00.000Z"),
        correlationId: "corr-maintenance-attest-service-order-second-001"
      });
      const before = await takeSnapshot(client, seed.validServiceOrderId);

      const [firstResult, secondResult] = await Promise.all([
        useCase.execute(firstCommand),
        useCase.execute(secondCommand)
      ]);
      const results = [firstResult, secondResult];

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toEqual({
        ok: false,
        reason: "SERVICE_ORDER_NOT_ATTESTABLE",
        serviceOrderId: seed.validServiceOrderId
      });

      const winnerIndex = results.findIndex((result) => result.ok);
      const loserIndex = results.findIndex((result) => !result.ok);
      if (winnerIndex < 0 || loserIndex < 0) {
        throw new Error("A concorrência deveria produzir exatamente um ateste vencedor.");
      }
      const winningCommand = [firstCommand, secondCommand][winnerIndex];
      const losingCommand = [firstCommand, secondCommand][loserIndex];
      const winningResult = results[winnerIndex];
      const losingResult = results[loserIndex];
      if (winningCommand === undefined || losingCommand === undefined) {
        throw new Error("O comando vencedor e o comando perdedor deveriam existir.");
      }

      expect(winningResult).toEqual({
        ok: true,
        serviceOrderId: seed.validServiceOrderId,
        status: "ATESTADA"
      });
      expect(losingResult).toEqual({
        ok: false,
        reason: "SERVICE_ORDER_NOT_ATTESTABLE",
        serviceOrderId: seed.validServiceOrderId
      });

      const afterAttestation = await takeSnapshot(client, seed.validServiceOrderId);
      expect(afterAttestation.status).toBe("ATESTADA");
      expect(afterAttestation.targets).toEqual(before.targets);
      expect(afterAttestation.services).toEqual(before.services);
      expect(afterAttestation.requestVersion).toBe(before.requestVersion);
      expect(afterAttestation.patrimonies).toEqual(before.patrimonies);
      expect(afterAttestation.auditCount).toBe(before.auditCount + 1);
      expect(afterAttestation.outboxCount).toBe(before.outboxCount + 1);
      await expectAuditAndOutboxOnce(client, seed.validServiceOrderId, winningCommand);

      await expect(useCase.execute(winningCommand)).resolves.toEqual(winningResult);
      await expect(useCase.execute(losingCommand)).resolves.toEqual(losingResult);
      expect(await takeSnapshot(client, seed.validServiceOrderId)).toEqual(afterAttestation);

      await expect(
        useCase.execute({
          ...winningCommand,
          attestedAt: new Date("2026-11-12T17:00:00.000Z")
        })
      ).resolves.toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(await takeSnapshot(client, seed.validServiceOrderId)).toEqual(afterAttestation);

      const unauthorizedBefore = await takeSnapshot(client, seed.unauthorizedServiceOrderId);
      await expect(
        useCase.execute(
          attestCommand(seed, {
            commandId: "cmd-maintenance-attest-service-order-unauthorized-001",
            serviceOrderId: seed.unauthorizedServiceOrderId,
            actorUserId: seed.partialScopeUserId,
            attestedAt: new Date("2026-11-12T18:00:00.000Z"),
            correlationId: "corr-maintenance-attest-service-order-unauthorized-001"
          })
        )
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        serviceOrderId: seed.unauthorizedServiceOrderId
      });
      expect(await takeSnapshot(client, seed.unauthorizedServiceOrderId)).toEqual(
        unauthorizedBefore
      );
      await expectNoAuditOrOutbox(client, seed.unauthorizedServiceOrderId);
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
  maintenanceRequestId: string;
  patrimonyIds: string[];
  authorizedUserId: string;
  partialScopeUserId: string;
  contractId: string;
  entityId: string;
};

type AttestCommandOverrides = Partial<AttestMaintenanceServiceOrderInput>;

function attestCommand(
  seed: ServiceOrderSeed,
  overrides: AttestCommandOverrides = {}
): AttestMaintenanceServiceOrderInput {
  return {
    commandId: "cmd-maintenance-attest-service-order-valid-001",
    serviceOrderId: seed.validServiceOrderId,
    attestedAt: new Date("2026-11-12T16:00:00.000Z"),
    actorUserId: seed.authorizedUserId,
    teamContext: "Patrimônio",
    correlationId: "corr-maintenance-attest-service-order-valid-001",
    ...overrides
  };
}

type Snapshot = {
  status: string;
  targets: Array<{ patrimony_id: string }>;
  services: Array<{ line_number: number; description: string }>;
  requestVersion: number;
  patrimonies: Array<{ id: string; operational_state: string; version: number }>;
  auditCount: number;
  outboxCount: number;
};

async function expectAuditAndOutboxOnce(
  client: Client,
  serviceOrderId: string,
  command: AttestMaintenanceServiceOrderInput
): Promise<void> {
  const audit = await client.query<{
    action: string;
    object_type: string;
    object_id: string;
    actor_user_id: string;
    team_context: string;
    correlation_id: string;
    previous_value: { status?: string };
    next_value: { status?: string; attestedAt?: string; attestedByUserId?: string };
  }>(
    `select "action", "object_type", "object_id", "actor_user_id", "team_context",
            "correlation_id", "previous_value", "next_value"
       from "audit_entry"
      where "action" = $1
        and "object_id" = $2`,
    [ATTEST_SERVICE_ORDER_ACTION, serviceOrderId]
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    action: ATTEST_SERVICE_ORDER_ACTION,
    object_type: "maintenance_service_order",
    object_id: serviceOrderId,
    actor_user_id: command.actorUserId,
    team_context: command.teamContext,
    correlation_id: command.correlationId,
    previous_value: { status: "EXECUTADA" },
    next_value: {
      status: "ATESTADA",
      attestedAt: command.attestedAt?.toISOString(),
      attestedByUserId: command.actorUserId,
      correlationId: command.correlationId
    }
  });

  const outbox = await client.query<{
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: {
      serviceOrderId?: string;
      status?: string;
      attestedAt?: string;
      attestedByUserId?: string;
      correlationId?: string;
    };
  }>(
    `select "event_type", "aggregate_type", "aggregate_id", "payload"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ATTESTED_EVENT, serviceOrderId]
  );
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0]).toMatchObject({
    event_type: SERVICE_ORDER_ATTESTED_EVENT,
    aggregate_type: "maintenance_service_order",
    aggregate_id: serviceOrderId,
    payload: {
      serviceOrderId,
      status: "ATESTADA",
      attestedAt: command.attestedAt?.toISOString(),
      attestedByUserId: command.actorUserId,
      correlationId: command.correlationId
    }
  });
}

async function expectNoAuditOrOutbox(client: Client, serviceOrderId: string): Promise<void> {
  const audit = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "action" = $1
        and "object_id" = $2`,
    [ATTEST_SERVICE_ORDER_ACTION, serviceOrderId]
  );
  const outbox = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ATTESTED_EVENT, serviceOrderId]
  );

  expect(audit.rows[0].count).toBe(0);
  expect(outbox.rows[0].count).toBe(0);
}

async function takeSnapshot(client: Client, serviceOrderId: string): Promise<Snapshot> {
  const order = await client.query<{ status: string; maintenance_request_id: string }>(
    `select "status"::text as "status", "maintenance_request_id"
       from "maintenance_service_order"
      where "id" = $1`,
    [serviceOrderId]
  );
  const orderRow = order.rows[0];
  if (orderRow === undefined) {
    throw new Error(`Service order ${serviceOrderId} not found while taking snapshot.`);
  }

  const targets = await client.query<{ patrimony_id: string }>(
    `select "patrimony_id"
       from "maintenance_service_order_patrimony"
      where "service_order_id" = $1
      order by "patrimony_id"`,
    [serviceOrderId]
  );
  const services = await client.query<{ line_number: number; description: string }>(
    `select "line_number", "description"
       from "maintenance_service_order_service"
      where "service_order_id" = $1
      order by "line_number"`,
    [serviceOrderId]
  );
  const request = await client.query<{ version: number }>(
    `select "version"
       from "maintenance_request"
      where "id" = $1`,
    [orderRow.maintenance_request_id]
  );
  const patrimonyIds = targets.rows.map((row) => row.patrimony_id);
  const patrimonies = await client.query<Snapshot["patrimonies"][number]>(
    `select "id", "operational_state"::text as "operational_state", "version"
       from "patrimony"
      where "id" = any($1::uuid[])
      order by "id"`,
    [patrimonyIds]
  );
  const audit = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "action" = $1
        and "object_id" = $2`,
    [ATTEST_SERVICE_ORDER_ACTION, serviceOrderId]
  );
  const outbox = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ATTESTED_EVENT, serviceOrderId]
  );

  return {
    status: orderRow.status,
    targets: targets.rows,
    services: services.rows,
    requestVersion: request.rows[0]?.version ?? -1,
    patrimonies: patrimonies.rows,
    auditCount: audit.rows[0].count,
    outboxCount: outbox.rows[0].count
  };
}

async function alignPartialAuthorizationWithFirstTarget(
  client: Client,
  seed: ServiceOrderSeed
): Promise<void> {
  const targets = await client.query<{ gre_code: string }>(
    `select g."code" as "gre_code"
       from "maintenance_service_order_patrimony" sop
       join "patrimony" p on p."id" = sop."patrimony_id"
       join "entity" e on e."id" = p."responsible_entity_id"
       join "gre" g on g."id" = e."gre_id"
      where sop."service_order_id" = $1`,
    [seed.unauthorizedServiceOrderId]
  );
  const firstTarget = targets.rows[0];
  if (firstTarget === undefined || targets.rows.length < 2) {
    throw new Error("The test requires at least two Patrimônio targets in distinct GREs.");
  }

  await client.query(
    `update "team_membership"
        set "gre_code" = $1,
            "updated_at" = current_timestamp
      where "user_id" = $2`,
    [firstTarget.gre_code, seed.partialScopeUserId]
  );
}

async function seedDependencies(client: Client): Promise<ServiceOrderSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const ids = {
    greOne: randomUUID(),
    greTwo: randomUUID(),
    entityOne: randomUUID(),
    entityTwo: randomUUID(),
    materialClass: randomUUID(),
    material: randomUUID(),
    authorizedPerson: randomUUID(),
    partialScopePerson: randomUUID(),
    authorizedUser: randomUUID(),
    partialScopeUser: randomUUID(),
    patrimonyTeam: randomUUID(),
    supplier: randomUUID(),
    contract: randomUUID(),
    contractItem: randomUUID(),
    request: randomUUID(),
    validServiceOrder: randomUUID(),
    unauthorizedServiceOrder: randomUUID(),
    patrimonyOne: randomUUID(),
    patrimonyTwo: randomUUID()
  };
  const greOneCode = `GRE-ATTEST-${suffix}-A`;
  const greTwoCode = `GRE-ATTEST-${suffix}-B`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
      ($1, $2, 'GRE de ateste A', current_timestamp),
      ($3, $4, 'GRE de ateste B', current_timestamp)`,
    [ids.greOne, greOneCode, ids.greTwo, greTwoCode]
  );
  await client.query(
    `insert into "entity" (
       "id", "code", "name", "entity_type", "gre_id", "updated_at"
     ) values
       ($1, $2, 'Entidade de ateste A', 'ESCOLA', $3, current_timestamp),
       ($4, $5, 'Entidade de ateste B', 'ESCOLA', $6, current_timestamp)`,
    [
      ids.entityOne,
      `ENT-ATTEST-${suffix}-A`,
      ids.greOne,
      ids.entityTwo,
      `ENT-ATTEST-${suffix}-B`,
      ids.greTwo
    ]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informática de ateste', current_timestamp)`,
    [ids.materialClass, `CLS-ATTEST-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Equipamento de ateste', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [ids.material, `MAT-ATTEST-${suffix}`, ids.materialClass]
  );
  await client.query(
    `insert into "patrimony" (
       "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
     ) values
       ($1, $3, $4, 'EM_USO', current_timestamp),
       ($2, $3, $5, 'EM_USO', current_timestamp)`,
    [ids.patrimonyOne, ids.patrimonyTwo, ids.material, ids.entityOne, ids.entityTwo]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
      ($1, 'Usuário autorizado no escopo completo', current_timestamp),
      ($2, 'Usuário autorizado em apenas um GRE', current_timestamp)`,
    [ids.authorizedPerson, ids.partialScopePerson]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values
       ($1, $2, $3, 'ACTIVE', false, current_timestamp),
       ($4, $5, $6, 'ACTIVE', false, current_timestamp)`,
    [
      ids.authorizedUser,
      ids.authorizedPerson,
      `authorized.attest.${suffix.toLowerCase()}@gmap.test`,
      ids.partialScopeUser,
      ids.partialScopePerson,
      `partial.attest.${suffix.toLowerCase()}@gmap.test`
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
       ($1, $2, $3, 'MEMBRO', 'GRE', $4, true, current_timestamp),
       ($5, $2, $3, 'MEMBRO', 'GRE', $6, true, current_timestamp),
       ($7, $8, $3, 'MEMBRO', 'GRE', $4, true, current_timestamp)`,
    [
      randomUUID(),
      ids.authorizedUser,
      ids.patrimonyTeam,
      greOneCode,
      randomUUID(),
      greTwoCode,
      randomUUID(),
      ids.partialScopeUser
    ]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de ateste', current_timestamp)`,
    [ids.supplier, `FORN-ATTEST-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de serviço para ateste', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-ATTEST-${suffix}`, ids.supplier]
  );
  await client.query(
    `insert into "contract_item" (
       "id", "code", "contract_id", "line_number", "material_singular_id",
       "contracted_quantity", "unit_price", "updated_at"
     ) values ($1, $2, $3, 1, $4, 10, 1250.50, current_timestamp)`,
    [ids.contractItem, `CTR-ATTEST-${suffix}-ITEM-001`, ids.contract, ids.material]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version",
       "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitação de ateste', 'Descrição de teste', $3,
       $3, $4, 'Autorização para teste de ateste', 1, $5, current_timestamp)`,
    [
      ids.request,
      ids.entityOne,
      new Date("2026-11-12T12:00:00.000Z"),
      ids.authorizedUser,
      `corr-maintenance-request-attest-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
       "correlation_id", "updated_at"
     ) values
       ($1, $3, $4, $6, $7, $8, current_timestamp),
       ($2, $3, $5, $6, $7, $8, current_timestamp)`,
    [
      randomUUID(),
      randomUUID(),
      ids.request,
      ids.patrimonyOne,
      ids.patrimonyTwo,
      new Date("2026-11-12T12:05:00.000Z"),
      ids.authorizedUser,
      `corr-maintenance-target-attest-${suffix}`
    ]
  );

  for (const [serviceOrderId, code] of [
    [ids.validServiceOrder, `OS-ATTEST-${suffix}-VALID`],
    [ids.unauthorizedServiceOrder, `OS-ATTEST-${suffix}-UNAUTHORIZED`]
  ] as const) {
    await client.query(
      `insert into "maintenance_service_order" (
         "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
         "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
       ) values ($1, $2, $3, $4, $5, 'EXECUTADA', $6, $7, $8, current_timestamp)`,
      [
        serviceOrderId,
        code,
        ids.request,
        ids.contract,
        ids.entityOne,
        new Date("2026-11-12T13:00:00.000Z"),
        ids.authorizedUser,
        `corr-maintenance-service-order-attest-${suffix}`
      ]
    );
    await client.query(
      `insert into "maintenance_service_order_patrimony" (
         "id", "service_order_id", "maintenance_request_id", "patrimony_id"
       ) values
         ($1, $2, $3, $4),
         ($5, $2, $3, $6)`,
      [randomUUID(), serviceOrderId, ids.request, ids.patrimonyOne, randomUUID(), ids.patrimonyTwo]
    );
    await client.query(
      `insert into "maintenance_service_order_service" (
         "id", "service_order_id", "contract_item_id", "line_number", "description",
         "quantity", "unit_price", "total_amount", "updated_at"
       ) values
         ($1, $2, $3, 1, 'Manutenção preventiva', 1, 1250.50, 1250.50, current_timestamp),
         ($4, $2, $3, 2, 'Troca de componente', 2, 1250.50, 2501.00, current_timestamp)`,
      [randomUUID(), serviceOrderId, ids.contractItem, randomUUID()]
    );
    await client.query(
      `insert into "maintenance_service_order_entity_confirmation" (
         "id", "service_order_id", "entity_id", "confirmed_at", "evidence_reference",
         "registered_by_user_id", "correlation_id"
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        serviceOrderId,
        ids.entityOne,
        new Date("2026-11-12T12:30:00.000Z"),
        `SEI-ATTEST-${suffix}-${serviceOrderId}`,
        ids.authorizedUser,
        `corr-maintenance-confirmation-attest-${suffix}-${serviceOrderId}`
      ]
    );
  }

  return {
    suffix,
    validServiceOrderId: ids.validServiceOrder,
    unauthorizedServiceOrderId: ids.unauthorizedServiceOrder,
    maintenanceRequestId: ids.request,
    patrimonyIds: [ids.patrimonyOne, ids.patrimonyTwo],
    authorizedUserId: ids.authorizedUser,
    partialScopeUserId: ids.partialScopeUser,
    contractId: ids.contract,
    entityId: ids.entityOne
  };
}
