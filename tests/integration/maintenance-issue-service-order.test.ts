import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { IssueMaintenanceServiceOrderInput } from "../../src/modules/maintenance/application/issue-maintenance-service-order";
import { IssueMaintenanceServiceOrder } from "../../src/modules/maintenance/application/issue-maintenance-service-order";
import { PostgresMaintenanceServiceOrderIssuer } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-issuer";

const execFileAsync = promisify(execFile);
const ISSUE_SERVICE_ORDER_ACTION = "maintenance.issue_service_order";
const SERVICE_ORDER_ISSUED_EVENT = "maintenance.service_order_issued";

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("emissão de Ordem de Serviço de manutenção", () => {
  it("emite uma OS com vários alvos e serviços, comprometendo saldo contratual por linha", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 8 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = new IssueMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderIssuer(pool)
      );
      const validCommand = serviceOrderCommand(seed);
      const initial = await takeSnapshot(client, seed, seed.validRequestId, seed.validPatrimonyIds);

      const issued = await useCase.execute(validCommand);
      expect(issued).toEqual({
        ok: true,
        serviceOrderId: expect.any(String),
        code: validCommand.code,
        maintenanceRequestId: seed.validRequestId,
        contractId: seed.activeContractId,
        entityId: seed.entityId,
        patrimonyIds: seed.validPatrimonyIds,
        serviceCount: 2,
        status: "EMITIDA"
      });
      if (!issued.ok) {
        throw new Error("A emissão válida da OS deveria ter sido aceita.");
      }

      await expectServiceOrder(client, seed, issued.serviceOrderId, validCommand);

      const afterIssue = await takeSnapshot(
        client,
        seed,
        seed.validRequestId,
        seed.validPatrimonyIds
      );
      expect(afterIssue.serviceOrderCount).toBe(initial.serviceOrderCount + 1);
      expect(afterIssue.serviceOrderPatrimonyCount).toBe(
        initial.serviceOrderPatrimonyCount + validCommand.patrimonyIds.length
      );
      expect(afterIssue.serviceCount).toBe(initial.serviceCount + validCommand.services.length);
      expect(afterIssue.auditCount).toBe(initial.auditCount + 1);
      expect(afterIssue.outboxCount).toBe(initial.outboxCount + 1);
      expect(afterIssue.contractBalance).toEqual({
        total_quantity: 20,
        committed_quantity: 7,
        available_quantity: 13,
        total_amount: "25010.00",
        committed_amount: "8753.50",
        available_amount: "16256.50",
        version: 3
      });
      expect(afterIssue.patrimonies).toEqual(initial.patrimonies);
      expect(afterIssue.patrimonyMovementCount).toBe(initial.patrimonyMovementCount);
      expect(afterIssue.patrimonyWriteOffCount).toBe(initial.patrimonyWriteOffCount);
      expect(afterIssue.request.version).toBe(initial.request.version + 1);

      await expectAuditAndOutboxOnce(client, issued.serviceOrderId, validCommand);

      await expect(useCase.execute(validCommand)).resolves.toEqual(issued);
      expect(await takeSnapshot(client, seed, seed.validRequestId, seed.validPatrimonyIds)).toEqual(
        afterIssue
      );

      await expect(
        useCase.execute({
          ...validCommand,
          code: `${validCommand.code}-ALTERADA`
        })
      ).resolves.toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(await takeSnapshot(client, seed, seed.validRequestId, seed.validPatrimonyIds)).toEqual(
        afterIssue
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed,
        serviceOrderCommand(seed, {
          commandId: "cmd-maintenance-service-order-inactive-contract-001",
          maintenanceRequestId: seed.inactiveContractRequestId,
          contractId: seed.inactiveContractId,
          patrimonyIds: [seed.inactiveContractPatrimonyId],
          code: `OS-${seed.suffix}-INACTIVE`
        }),
        "CONTRACT_NOT_APPLICABLE",
        seed.inactiveContractRequestId,
        [seed.inactiveContractPatrimonyId]
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed,
        serviceOrderCommand(seed, {
          commandId: "cmd-maintenance-service-order-expired-contract-001",
          maintenanceRequestId: seed.expiredContractRequestId,
          contractId: seed.expiredContractId,
          patrimonyIds: [seed.expiredContractPatrimonyId],
          code: `OS-${seed.suffix}-EXPIRED`
        }),
        "CONTRACT_NOT_APPLICABLE",
        seed.expiredContractRequestId,
        [seed.expiredContractPatrimonyId]
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed,
        serviceOrderCommand(seed, {
          commandId: "cmd-maintenance-service-order-no-strategy-001",
          maintenanceRequestId: seed.noStrategyRequestId,
          patrimonyIds: [seed.noStrategyPatrimonyId],
          code: `OS-${seed.suffix}-NO-STRATEGY`
        }),
        "PATRIMONY_STRATEGY_NOT_DEFINED",
        seed.noStrategyRequestId,
        [seed.noStrategyPatrimonyId]
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed,
        serviceOrderCommand(seed, {
          commandId: "cmd-maintenance-service-order-divergent-contract-001",
          maintenanceRequestId: seed.divergentContractRequestId,
          patrimonyIds: [seed.divergentContractPatrimonyId],
          code: `OS-${seed.suffix}-DIVERGENT`
        }),
        "PATRIMONY_STRATEGY_CONTRACT_MISMATCH",
        seed.divergentContractRequestId,
        [seed.divergentContractPatrimonyId]
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed,
        serviceOrderCommand(seed, {
          commandId: "cmd-maintenance-service-order-out-of-scope-001",
          maintenanceRequestId: seed.outOfScopeRequestId,
          patrimonyIds: [seed.outOfScopePatrimonyId],
          actorUserId: seed.outOfScopeUserId,
          code: `OS-${seed.suffix}-OUT-OF-SCOPE`
        }),
        "ACTOR_NOT_AUTHORIZED",
        seed.outOfScopeRequestId,
        [seed.outOfScopePatrimonyId]
      );
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);
});

type ServiceOrderCommandOverrides = Partial<IssueMaintenanceServiceOrderInput>;

function serviceOrderCommand(
  seed: ServiceOrderSeed,
  overrides: ServiceOrderCommandOverrides = {}
): IssueMaintenanceServiceOrderInput {
  return {
    commandId: "cmd-maintenance-service-order-valid-001",
    code: `OS-${seed.suffix}-VALID`,
    maintenanceRequestId: seed.validRequestId,
    contractId: seed.activeContractId,
    entityId: seed.entityId,
    patrimonyIds: seed.validPatrimonyIds,
    services: [
      {
        description: "Manutenção preventiva",
        contractItemId: seed.contractItemId,
        quantity: 1
      },
      {
        description: "Troca de componente",
        contractItemId: seed.contractItemId,
        quantity: 2
      }
    ],
    issuedAt: new Date("2026-11-11T14:00:00.000Z"),
    actorUserId: seed.compatibleGreUserId,
    teamContext: "Patrimônio",
    correlationId: "corr-maintenance-service-order-valid-001",
    ...overrides
  };
}

type ServiceOrderSeed = {
  suffix: string;
  entityId: string;
  primaryGreCode: string;
  validRequestId: string;
  inactiveContractRequestId: string;
  expiredContractRequestId: string;
  noStrategyRequestId: string;
  divergentContractRequestId: string;
  outOfScopeRequestId: string;
  validPatrimonyIds: string[];
  inactiveContractPatrimonyId: string;
  expiredContractPatrimonyId: string;
  noStrategyPatrimonyId: string;
  divergentContractPatrimonyId: string;
  outOfScopePatrimonyId: string;
  compatibleGreUserId: string;
  outOfScopeUserId: string;
  activeContractId: string;
  inactiveContractId: string;
  expiredContractId: string;
  divergentContractId: string;
  contractItemId: string;
};

type Snapshot = {
  request: { status: string; version: number };
  serviceOrderCount: number;
  serviceOrderPatrimonyCount: number;
  serviceCount: number;
  auditCount: number;
  outboxCount: number;
  contractBalance: {
    total_quantity: number;
    committed_quantity: number;
    available_quantity: number;
    total_amount: string;
    committed_amount: string;
    available_amount: string;
    version: number;
  } | null;
  patrimonies: Array<{ id: string; operational_state: string; version: number }>;
  patrimonyMovementCount: number;
  patrimonyWriteOffCount: number;
};

async function expectServiceOrder(
  client: Client,
  seed: ServiceOrderSeed,
  serviceOrderId: string,
  command: IssueMaintenanceServiceOrderInput
): Promise<void> {
  const order = await client.query<{
    id: string;
    code: string;
    maintenance_request_id: string;
    contract_id: string;
    entity_id: string;
    status: string;
    issued_by_user_id: string;
    correlation_id: string;
  }>(
    `select "id", "code", "maintenance_request_id", "contract_id", "entity_id",
            "status"::text as "status", "issued_by_user_id", "correlation_id"
       from "maintenance_service_order"
      where "id" = $1`,
    [serviceOrderId]
  );

  expect(order.rows).toEqual([
    {
      id: serviceOrderId,
      code: command.code,
      maintenance_request_id: seed.validRequestId,
      contract_id: seed.activeContractId,
      entity_id: seed.entityId,
      status: "EMITIDA",
      issued_by_user_id: seed.compatibleGreUserId,
      correlation_id: command.correlationId
    }
  ]);

  const patrimonyTargets = await client.query<{ patrimony_id: string }>(
    `select "patrimony_id"
       from "maintenance_service_order_patrimony"
      where "service_order_id" = $1
      order by "patrimony_id"`,
    [serviceOrderId]
  );
  expect(patrimonyTargets.rows.map((row) => row.patrimony_id)).toEqual(
    [...command.patrimonyIds].sort()
  );

  const services = await client.query<{
    line_number: number;
    description: string;
    contract_item_id: string;
    quantity: number;
    unit_price: string;
    total_amount: string;
  }>(
    `select "line_number", "description", "contract_item_id", "quantity",
            "unit_price"::text as "unit_price", "total_amount"::text as "total_amount"
       from "maintenance_service_order_service"
      where "service_order_id" = $1
      order by "line_number"`,
    [serviceOrderId]
  );
  expect(services.rows).toEqual(
    command.services.map((service, index) => ({
      line_number: index + 1,
      description: service.description,
      contract_item_id: service.contractItemId,
      quantity: service.quantity,
      unit_price: "1250.50",
      total_amount: (service.quantity * 1250.5).toFixed(2)
    }))
  );
}

async function expectAuditAndOutboxOnce(
  client: Client,
  serviceOrderId: string,
  command: IssueMaintenanceServiceOrderInput
): Promise<void> {
  const audit = await client.query<{
    action: string;
    object_type: string;
    object_id: string;
    correlation_id: string;
  }>(
    `select "action", "object_type", "object_id", "correlation_id"
       from "audit_entry"
      where "action" = $1
        and "object_id" = $2`,
    [ISSUE_SERVICE_ORDER_ACTION, serviceOrderId]
  );
  expect(audit.rows).toEqual([
    {
      action: ISSUE_SERVICE_ORDER_ACTION,
      object_type: "maintenance_service_order",
      object_id: serviceOrderId,
      correlation_id: command.correlationId
    }
  ]);

  const outbox = await client.query<{
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: { serviceOrderId?: string; code?: string };
  }>(
    `select "event_type", "aggregate_type", "aggregate_id", "payload"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ISSUED_EVENT, serviceOrderId]
  );
  expect(outbox.rows).toEqual([
    {
      event_type: SERVICE_ORDER_ISSUED_EVENT,
      aggregate_type: "maintenance_service_order",
      aggregate_id: serviceOrderId,
      payload: expect.objectContaining({
        serviceOrderId,
        code: command.code
      })
    }
  ]);
}

async function expectRejectedWithoutMutation(
  useCase: IssueMaintenanceServiceOrder,
  client: Client,
  seed: ServiceOrderSeed,
  command: IssueMaintenanceServiceOrderInput,
  reason: string,
  requestId: string,
  patrimonyIds: string[]
): Promise<void> {
  const before = await takeSnapshot(client, seed, requestId, patrimonyIds);
  await expect(useCase.execute(command)).resolves.toEqual({
    ok: false,
    reason,
    ...(reason === "CONTRACT_NOT_APPLICABLE" ? { contractId: command.contractId } : {}),
    ...(reason === "PATRIMONY_STRATEGY_NOT_DEFINED" ||
    reason === "PATRIMONY_STRATEGY_CONTRACT_MISMATCH" ||
    reason === "ACTOR_NOT_AUTHORIZED"
      ? { patrimonyId: patrimonyIds[0] }
      : {})
  });
  expect(await takeSnapshot(client, seed, requestId, patrimonyIds)).toEqual(before);
}

async function takeSnapshot(
  client: Client,
  seed: ServiceOrderSeed,
  requestId: string,
  patrimonyIds: string[]
): Promise<Snapshot> {
  const request = await client.query<{ status: string; version: number }>(
    `select "status"::text as "status", "version"
       from "maintenance_request"
      where "id" = $1`,
    [requestId]
  );
  const serviceOrderCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "maintenance_service_order"
      where "maintenance_request_id" = $1`,
    [requestId]
  );
  const serviceOrderPatrimonyCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "maintenance_service_order_patrimony"
      where "maintenance_request_id" = $1`,
    [requestId]
  );
  const serviceCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "maintenance_service_order_service" s
       join "maintenance_service_order" o on o."id" = s."service_order_id"
      where o."maintenance_request_id" = $1`,
    [requestId]
  );
  const auditCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "action" = $1`,
    [ISSUE_SERVICE_ORDER_ACTION]
  );
  const outboxCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "event_type" = $1`,
    [SERVICE_ORDER_ISSUED_EVENT]
  );
  const contractBalance = await client.query<NonNullable<Snapshot["contractBalance"]>>(
    `select "total_quantity", "committed_quantity", "available_quantity",
            "total_amount"::text as "total_amount",
            "committed_amount"::text as "committed_amount",
            "available_amount"::text as "available_amount", "version"
       from "contract_balance_position"
      where "contract_item_id" = $1`,
    [seed.contractItemId]
  );
  const patrimonies = await client.query<Snapshot["patrimonies"][number]>(
    `select "id", "operational_state"::text as "operational_state", "version"
       from "patrimony"
      where "id" = any($1::uuid[])
      order by "id"`,
    [patrimonyIds]
  );
  const patrimonyMovementCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "patrimony_movement"
      where "patrimony_id" = any($1::uuid[])`,
    [patrimonyIds]
  );
  const patrimonyWriteOffCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "patrimony_write_off"
      where "patrimony_id" = any($1::uuid[])`,
    [patrimonyIds]
  );

  return {
    request: request.rows[0],
    serviceOrderCount: serviceOrderCount.rows[0].count,
    serviceOrderPatrimonyCount: serviceOrderPatrimonyCount.rows[0].count,
    serviceCount: serviceCount.rows[0].count,
    auditCount: auditCount.rows[0].count,
    outboxCount: outboxCount.rows[0].count,
    contractBalance: contractBalance.rows[0] ?? null,
    patrimonies: patrimonies.rows,
    patrimonyMovementCount: patrimonyMovementCount.rows[0].count,
    patrimonyWriteOffCount: patrimonyWriteOffCount.rows[0].count
  };
}

async function seedDependencies(client: Client): Promise<ServiceOrderSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const primaryGreId = randomUUID();
  const secondaryGreId = randomUUID();
  const primaryGreCode = `GRE-SO-${suffix}`;
  const secondaryGreCode = `GRE-SO-OUT-${suffix}`;
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialId = randomUUID();
  const patrimonyIds = {
    validOne: randomUUID(),
    validTwo: randomUUID(),
    inactiveContract: randomUUID(),
    expiredContract: randomUUID(),
    noStrategy: randomUUID(),
    divergentContract: randomUUID(),
    outOfScope: randomUUID()
  };
  const requestIds = {
    valid: randomUUID(),
    inactiveContract: randomUUID(),
    expiredContract: randomUUID(),
    noStrategy: randomUUID(),
    divergentContract: randomUUID(),
    outOfScope: randomUUID()
  };
  const users = {
    compatibleGre: randomUUID(),
    compatibleGrePerson: randomUUID(),
    outOfScope: randomUUID(),
    outOfScopePerson: randomUUID(),
    manager: randomUUID(),
    managerPerson: randomUUID()
  };
  const teams = {
    patrimony: randomUUID(),
    management: randomUUID()
  };
  const contracts = {
    active: randomUUID(),
    inactive: randomUUID(),
    expired: randomUUID(),
    divergent: randomUUID()
  };
  const supplierId = randomUUID();
  const contractItemId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
       ($1, $2, 'GRE de manutenção', current_timestamp),
       ($3, $4, 'GRE fora do escopo', current_timestamp)`,
    [primaryGreId, primaryGreCode, secondaryGreId, secondaryGreCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, $2, 'Entidade solicitante', 'ESCOLA', $3, current_timestamp)`,
    [entityId, `ENT-SO-${suffix}`, primaryGreId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informática', current_timestamp)`,
    [materialClassId, `CLS-SO-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Equipamento de manutenção', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, `MAT-SO-${suffix}`, materialClassId]
  );
  for (const patrimonyId of Object.values(patrimonyIds)) {
    await client.query(
      `insert into "patrimony" (
         "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
       ) values ($1, $2, $3, 'EM_USO', current_timestamp)`,
      [patrimonyId, materialId, entityId]
    );
  }

  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
       ($1, 'Patrimônio GRE', current_timestamp),
       ($2, 'Patrimônio fora do escopo', current_timestamp),
       ($3, 'Gerência', current_timestamp)`,
    [users.compatibleGrePerson, users.outOfScopePerson, users.managerPerson]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values
       ($1, $2, $3, 'ACTIVE', false, current_timestamp),
       ($4, $5, $6, 'ACTIVE', false, current_timestamp),
       ($7, $8, $9, 'ACTIVE', false, current_timestamp)`,
    [
      users.compatibleGre,
      users.compatibleGrePerson,
      `patrimonio.gre.${suffix.toLowerCase()}@gmap.test`,
      users.outOfScope,
      users.outOfScopePerson,
      `patrimonio.out.${suffix.toLowerCase()}@gmap.test`,
      users.manager,
      users.managerPerson,
      `gerencia.${suffix.toLowerCase()}@gmap.test`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values
       ($1, 'Patrimônio', current_timestamp),
       ($2, 'Gerência', current_timestamp)`,
    [teams.patrimony, teams.management]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
     ) values
       ($1, $2, $3, 'MEMBRO', 'GRE', $4, true, current_timestamp),
       ($5, $6, $3, 'MEMBRO', 'GRE', $7, true, current_timestamp)`,
    [
      randomUUID(),
      users.compatibleGre,
      teams.patrimony,
      primaryGreCode,
      randomUUID(),
      users.outOfScope,
      secondaryGreCode
    ]
  );

  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de manutenção', current_timestamp)`,
    [supplierId, `FORN-SO-${suffix}`]
  );
  for (const [index, contract] of Object.entries(contracts)) {
    const validityStart = index === "expired" ? "2025-01-01" : "2026-01-01";
    const validityEnd = index === "expired" ? "2026-10-31" : "2026-12-31";
    await client.query(
      `insert into "contract" (
         "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
       ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
      [
        contract,
        `CTR-SO-${index.toUpperCase()}-${suffix}`,
        supplierId,
        `Contrato de serviço ${index}`,
        validityStart,
        validityEnd,
        index !== "inactive"
      ]
    );
  }
  await client.query(
    `insert into "contract_item" (
       "id", "code", "contract_id", "line_number", "material_singular_id",
       "contracted_quantity", "unit_price", "updated_at"
     ) values ($1, $2, $3, 1, $4, 20, 1250.50, current_timestamp)`,
    [contractItemId, `CTR-SO-${suffix}-ITEM-001`, contracts.active, materialId]
  );
  await client.query(
    `insert into "contract_balance_position" (
       "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
       "total_amount", "committed_amount", "available_amount", "version", "updated_at"
     ) values ($1, $2, 20, 4, 16, 25010.00, 5002.00, 20008.00, 1, current_timestamp)`,
    [randomUUID(), contractItemId]
  );

  for (const requestId of Object.values(requestIds)) {
    await insertAuthorizedRequest(client, requestId, entityId, users.manager, suffix);
  }

  await insertTarget(client, requestIds.valid, patrimonyIds.validOne, users.compatibleGre, suffix);
  await insertTarget(client, requestIds.valid, patrimonyIds.validTwo, users.compatibleGre, suffix);
  await insertStrategy(
    client,
    requestIds.valid,
    patrimonyIds.validOne,
    contracts.active,
    users.compatibleGre,
    suffix
  );
  await insertStrategy(
    client,
    requestIds.valid,
    patrimonyIds.validTwo,
    contracts.active,
    users.compatibleGre,
    suffix
  );

  await insertTarget(
    client,
    requestIds.inactiveContract,
    patrimonyIds.inactiveContract,
    users.compatibleGre,
    suffix
  );
  await insertStrategy(
    client,
    requestIds.inactiveContract,
    patrimonyIds.inactiveContract,
    contracts.inactive,
    users.compatibleGre,
    suffix
  );

  await insertTarget(
    client,
    requestIds.expiredContract,
    patrimonyIds.expiredContract,
    users.compatibleGre,
    suffix
  );
  await insertStrategy(
    client,
    requestIds.expiredContract,
    patrimonyIds.expiredContract,
    contracts.expired,
    users.compatibleGre,
    suffix
  );

  await insertTarget(
    client,
    requestIds.noStrategy,
    patrimonyIds.noStrategy,
    users.compatibleGre,
    suffix
  );

  await insertTarget(
    client,
    requestIds.divergentContract,
    patrimonyIds.divergentContract,
    users.compatibleGre,
    suffix
  );
  await insertStrategy(
    client,
    requestIds.divergentContract,
    patrimonyIds.divergentContract,
    contracts.divergent,
    users.compatibleGre,
    suffix
  );

  await insertTarget(
    client,
    requestIds.outOfScope,
    patrimonyIds.outOfScope,
    users.compatibleGre,
    suffix
  );
  await insertStrategy(
    client,
    requestIds.outOfScope,
    patrimonyIds.outOfScope,
    contracts.active,
    users.compatibleGre,
    suffix
  );

  return {
    suffix,
    entityId,
    primaryGreCode,
    validRequestId: requestIds.valid,
    inactiveContractRequestId: requestIds.inactiveContract,
    expiredContractRequestId: requestIds.expiredContract,
    noStrategyRequestId: requestIds.noStrategy,
    divergentContractRequestId: requestIds.divergentContract,
    outOfScopeRequestId: requestIds.outOfScope,
    validPatrimonyIds: [patrimonyIds.validOne, patrimonyIds.validTwo],
    inactiveContractPatrimonyId: patrimonyIds.inactiveContract,
    expiredContractPatrimonyId: patrimonyIds.expiredContract,
    noStrategyPatrimonyId: patrimonyIds.noStrategy,
    divergentContractPatrimonyId: patrimonyIds.divergentContract,
    outOfScopePatrimonyId: patrimonyIds.outOfScope,
    compatibleGreUserId: users.compatibleGre,
    outOfScopeUserId: users.outOfScope,
    activeContractId: contracts.active,
    inactiveContractId: contracts.inactive,
    expiredContractId: contracts.expired,
    divergentContractId: contracts.divergent,
    contractItemId
  };
}

async function insertAuthorizedRequest(
  client: Client,
  requestId: string,
  entityId: string,
  managerUserId: string,
  suffix: string
): Promise<void> {
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version", "correlation_id",
       "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitação de manutenção', 'Descrição da solicitação',
       '2026-11-11T10:00:00.000Z', '2026-11-11T12:00:00.000Z', $3,
       'Autorização da Gerência', 2, $4, current_timestamp)`,
    [requestId, entityId, managerUserId, `corr-request-${suffix}-${requestId}`]
  );
}

async function insertTarget(
  client: Client,
  requestId: string,
  patrimonyId: string,
  linkedByUserId: string,
  suffix: string
): Promise<void> {
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
       "correlation_id", "updated_at"
     ) values ($1, $2, $3, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp)`,
    [randomUUID(), requestId, patrimonyId, linkedByUserId, `corr-target-${suffix}-${patrimonyId}`]
  );
}

async function insertStrategy(
  client: Client,
  requestId: string,
  patrimonyId: string,
  contractId: string,
  definedByUserId: string,
  suffix: string
): Promise<void> {
  await client.query(
    `insert into "maintenance_request_patrimony_strategy" (
       "id", "maintenance_request_id", "patrimony_id", "strategy_type", "contract_id",
       "justification", "defined_at", "defined_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, 'CONTRATO_SERVICO', $4, 'Atendimento coberto por contrato vigente.',
       '2026-11-11T13:15:00.000Z', $5, $6, current_timestamp)`,
    [
      randomUUID(),
      requestId,
      patrimonyId,
      contractId,
      definedByUserId,
      `corr-strategy-${suffix}-${patrimonyId}`
    ]
  );
}
