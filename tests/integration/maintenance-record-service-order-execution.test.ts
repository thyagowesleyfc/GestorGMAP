import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { RecordMaintenanceServiceOrderExecutionInput } from "../../src/modules/maintenance/application/record-maintenance-service-order-execution";
import { RecordMaintenanceServiceOrderExecution } from "../../src/modules/maintenance/application/record-maintenance-service-order-execution";
import { PostgresMaintenanceServiceOrderExecutionRecorder } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-execution-recorder";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("registro da execucao de Ordem de Servico de manutencao", () => {
  it("executa uma OS enviada com idempotencia, autorizacao e efeitos isolados", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 8 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = new RecordMaintenanceServiceOrderExecution(
        new PostgresMaintenanceServiceOrderExecutionRecorder(pool)
      );
      const validCommand = executionCommand(seed);
      const before = await takeSnapshot(client, seed.validServiceOrderId, seed.contractItemId);

      const executed = await useCase.execute(validCommand);

      expect(executed).toEqual({
        ok: true,
        serviceOrderId: seed.validServiceOrderId,
        status: "EXECUTADA"
      });

      const afterExecution = await takeSnapshot(
        client,
        seed.validServiceOrderId,
        seed.contractItemId
      );
      expect(afterExecution.status).toBe("EXECUTADA");
      expect(afterExecution.targets).toEqual(before.targets);
      expect(afterExecution.services).toEqual(before.services);
      expect(afterExecution.requestVersion).toBe(before.requestVersion);
      expect(afterExecution.patrimonies).toEqual(before.patrimonies);
      expect(afterExecution.contractBalance).toEqual(before.contractBalance);
      expect(afterExecution.patrimonyMovementCount).toBe(before.patrimonyMovementCount);
      expect(afterExecution.patrimonyWriteOffCount).toBe(before.patrimonyWriteOffCount);
      expect(afterExecution.auditCount).toBe(before.auditCount + 1);
      expect(afterExecution.outboxCount).toBe(before.outboxCount + 1);
      await expectAuditAndOutboxOnce(client, seed.validServiceOrderId, validCommand);

      await expect(useCase.execute(validCommand)).resolves.toEqual(executed);
      expect(await takeSnapshot(client, seed.validServiceOrderId, seed.contractItemId)).toEqual(
        afterExecution
      );

      await expect(
        useCase.execute({
          ...validCommand,
          executedAt: new Date("2026-11-12T15:00:00.000Z")
        })
      ).resolves.toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(await takeSnapshot(client, seed.validServiceOrderId, seed.contractItemId)).toEqual(
        afterExecution
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed.contractItemId,
        {
          ...validCommand,
          commandId: "cmd-maintenance-execution-invalid-state-001",
          serviceOrderId: seed.invalidStateServiceOrderId
        },
        "SERVICE_ORDER_NOT_EXECUTABLE"
      );

      await expectRejectedWithoutMutation(
        useCase,
        client,
        seed.contractItemId,
        {
          ...validCommand,
          commandId: "cmd-maintenance-execution-out-of-scope-001",
          serviceOrderId: seed.unauthorizedServiceOrderId,
          actorUserId: seed.outOfScopeUserId
        },
        "ACTOR_NOT_AUTHORIZED"
      );

      const missingServiceOrderId = randomUUID();
      const beforeMissing = await takeSideEffectSnapshot(client);
      await expect(
        useCase.execute({
          ...validCommand,
          commandId: "cmd-maintenance-execution-not-found-001",
          serviceOrderId: missingServiceOrderId
        })
      ).resolves.toEqual({
        ok: false,
        reason: "SERVICE_ORDER_NOT_FOUND",
        serviceOrderId: missingServiceOrderId
      });
      expect(await takeSideEffectSnapshot(client)).toEqual(beforeMissing);
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
  invalidStateServiceOrderId: string;
  unauthorizedServiceOrderId: string;
  maintenanceRequestId: string;
  patrimonyIds: string[];
  authorizedUserId: string;
  outOfScopeUserId: string;
  contractItemId: string;
};

type ExecutionCommandOverrides = Partial<RecordMaintenanceServiceOrderExecutionInput>;

function executionCommand(
  seed: ServiceOrderSeed,
  overrides: ExecutionCommandOverrides = {}
): RecordMaintenanceServiceOrderExecutionInput {
  return {
    commandId: "cmd-maintenance-execution-valid-001",
    serviceOrderId: seed.validServiceOrderId,
    executedAt: new Date("2026-11-12T14:30:00.000Z"),
    actorUserId: seed.authorizedUserId,
    teamContext: "Patrimônio",
    correlationId: "corr-maintenance-execution-valid-001",
    ...overrides
  };
}

type Snapshot = {
  status: string;
  targets: Array<{ patrimony_id: string }>;
  services: Array<{ line_number: number; description: string }>;
  requestVersion: number;
  patrimonies: Array<{ id: string; operational_state: string; version: number }>;
  contractBalance: {
    total_quantity: number;
    committed_quantity: number;
    available_quantity: number;
    total_amount: string;
    committed_amount: string;
    available_amount: string;
    version: number;
  } | null;
  patrimonyMovementCount: number;
  patrimonyWriteOffCount: number;
  auditCount: number;
  outboxCount: number;
};

type SideEffectSnapshot = {
  auditCount: number;
  outboxCount: number;
};

async function expectAuditAndOutboxOnce(
  client: Client,
  serviceOrderId: string,
  command: RecordMaintenanceServiceOrderExecutionInput
): Promise<void> {
  const audit = await client.query<{
    object_type: string;
    object_id: string;
    correlation_id: string;
    previous_value: { status?: string };
    next_value: { status?: string };
  }>(
    `select "object_type", "object_id", "correlation_id",
            "previous_value", "next_value"
       from "audit_entry"
      where "object_type" = 'maintenance_service_order'
        and "object_id" = $1`,
    [serviceOrderId]
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    object_type: "maintenance_service_order",
    object_id: serviceOrderId,
    correlation_id: command.correlationId,
    previous_value: { status: "ENVIADA_AO_PRESTADOR" },
    next_value: { status: "EXECUTADA" }
  });

  const outbox = await client.query<{
    aggregate_type: string;
    aggregate_id: string;
    payload: { serviceOrderId?: string; status?: string };
  }>(
    `select "aggregate_type", "aggregate_id", "payload"
       from "outbox_event"
      where "aggregate_type" = 'maintenance_service_order'
        and "aggregate_id" = $1`,
    [serviceOrderId]
  );
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0]).toMatchObject({
    aggregate_type: "maintenance_service_order",
    aggregate_id: serviceOrderId,
    payload: expect.objectContaining({
      serviceOrderId,
      status: "EXECUTADA"
    })
  });
}

async function expectRejectedWithoutMutation(
  useCase: RecordMaintenanceServiceOrderExecution,
  client: Client,
  contractItemId: string,
  command: RecordMaintenanceServiceOrderExecutionInput,
  reason: string
): Promise<void> {
  const before = await takeSnapshot(client, command.serviceOrderId, contractItemId);

  await expect(useCase.execute(command)).resolves.toEqual({
    ok: false,
    reason,
    serviceOrderId: command.serviceOrderId
  });
  expect(await takeSnapshot(client, command.serviceOrderId, contractItemId)).toEqual(before);
}

async function takeSnapshot(
  client: Client,
  serviceOrderId: string,
  contractItemId: string
): Promise<Snapshot> {
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
  const contractBalance = await client.query<NonNullable<Snapshot["contractBalance"]>>(
    `select "total_quantity", "committed_quantity", "available_quantity",
            "total_amount"::text as "total_amount",
            "committed_amount"::text as "committed_amount",
            "available_amount"::text as "available_amount", "version"
       from "contract_balance_position"
      where "contract_item_id" = $1`,
    [contractItemId]
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
  const auditCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "object_type" = 'maintenance_service_order'
        and "object_id" = $1`,
    [serviceOrderId]
  );
  const outboxCount = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "aggregate_type" = 'maintenance_service_order'
        and "aggregate_id" = $1`,
    [serviceOrderId]
  );

  return {
    status: orderRow.status,
    targets: targets.rows,
    services: services.rows,
    requestVersion: request.rows[0]?.version ?? -1,
    patrimonies: patrimonies.rows,
    contractBalance: contractBalance.rows[0] ?? null,
    patrimonyMovementCount: patrimonyMovementCount.rows[0].count,
    patrimonyWriteOffCount: patrimonyWriteOffCount.rows[0].count,
    auditCount: auditCount.rows[0].count,
    outboxCount: outboxCount.rows[0].count
  };
}

async function takeSideEffectSnapshot(client: Client): Promise<SideEffectSnapshot> {
  const audit = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "audit_entry"
      where "object_type" = 'maintenance_service_order'`
  );
  const outbox = await client.query<{ count: number }>(
    `select count(*)::int as "count"
       from "outbox_event"
      where "aggregate_type" = 'maintenance_service_order'`
  );

  return {
    auditCount: audit.rows[0].count,
    outboxCount: outbox.rows[0].count
  };
}

async function seedDependencies(client: Client): Promise<ServiceOrderSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const ids = {
    gre: randomUUID(),
    outOfScopeGre: randomUUID(),
    entity: randomUUID(),
    materialClass: randomUUID(),
    material: randomUUID(),
    authorizedPerson: randomUUID(),
    outOfScopePerson: randomUUID(),
    authorizedUser: randomUUID(),
    outOfScopeUser: randomUUID(),
    patrimonyTeam: randomUUID(),
    supplier: randomUUID(),
    contract: randomUUID(),
    contractItem: randomUUID(),
    request: randomUUID(),
    validServiceOrder: randomUUID(),
    invalidStateServiceOrder: randomUUID(),
    unauthorizedServiceOrder: randomUUID(),
    patrimonyOne: randomUUID(),
    patrimonyTwo: randomUUID()
  };
  const greCode = `GRE-EXEC-${suffix}`;
  const outOfScopeGreCode = `GRE-EXEC-OUT-${suffix}`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
       ($1, $2, 'GRE de manutencao', current_timestamp),
       ($3, $4, 'GRE fora do escopo', current_timestamp)`,
    [ids.gre, greCode, ids.outOfScopeGre, outOfScopeGreCode]
  );
  await client.query(
    `insert into "entity" (
       "id", "code", "name", "entity_type", "gre_id", "updated_at"
     ) values ($1, $2, 'Unidade de manutencao', 'ESCOLA', $3, current_timestamp)`,
    [ids.entity, `ENT-EXEC-${suffix}`, ids.gre]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informatica', current_timestamp)`,
    [ids.materialClass, `CLS-EXEC-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Equipamento de manutencao', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [ids.material, `MAT-EXEC-${suffix}`, ids.materialClass]
  );
  await client.query(
    `insert into "patrimony" (
       "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
     ) values
       ($1, $3, $4, 'EM_USO', current_timestamp),
       ($2, $3, $4, 'EM_USO', current_timestamp)`,
    [ids.patrimonyOne, ids.patrimonyTwo, ids.material, ids.entity]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
       ($1, 'Usuario autorizado', current_timestamp),
       ($2, 'Usuario fora do escopo', current_timestamp)`,
    [ids.authorizedPerson, ids.outOfScopePerson]
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
      `authorized.execution.${suffix.toLowerCase()}@gmap.test`,
      ids.outOfScopeUser,
      ids.outOfScopePerson,
      `out.scope.execution.${suffix.toLowerCase()}@gmap.test`
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
       ($5, $6, $3, 'MEMBRO', 'GRE', $7, true, current_timestamp)`,
    [
      randomUUID(),
      ids.authorizedUser,
      ids.patrimonyTeam,
      greCode,
      randomUUID(),
      ids.outOfScopeUser,
      outOfScopeGreCode
    ]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de manutencao', current_timestamp)`,
    [ids.supplier, `FORN-EXEC-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de servico', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-EXEC-${suffix}`, ids.supplier]
  );
  await client.query(
    `insert into "contract_item" (
       "id", "code", "contract_id", "line_number", "material_singular_id",
       "contracted_quantity", "unit_price", "updated_at"
     ) values ($1, $2, $3, 1, $4, 20, 1250.50, current_timestamp)`,
    [ids.contractItem, `CTR-EXEC-${suffix}-ITEM-001`, ids.contract, ids.material]
  );
  await client.query(
    `insert into "contract_balance_position" (
       "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
       "total_amount", "committed_amount", "available_amount", "version", "updated_at"
     ) values ($1, $2, 20, 4, 16, 25010.00, 5002.00, 20008.00, 1, current_timestamp)`,
    [randomUUID(), ids.contractItem]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitacao de manutencao', 'Descricao', $3,
       $3, $4, 'Autorizacao para teste', $5, current_timestamp)`,
    [
      ids.request,
      ids.entity,
      new Date("2026-11-12T12:00:00.000Z"),
      ids.authorizedUser,
      `corr-request-execution-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id", "correlation_id", "updated_at"
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
      `corr-target-execution-${suffix}`
    ]
  );

  for (const [serviceOrderId, code, status] of [
    [ids.validServiceOrder, `OS-EXEC-${suffix}-VALID`, "ENVIADA_AO_PRESTADOR"],
    [ids.invalidStateServiceOrder, `OS-EXEC-${suffix}-ISSUED`, "EMITIDA"],
    [ids.unauthorizedServiceOrder, `OS-EXEC-${suffix}-OUT`, "ENVIADA_AO_PRESTADOR"]
  ] as const) {
    await client.query(
      `insert into "maintenance_service_order" (
         "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
         "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
       ) values ($1, $2, $3, $4, $5, $6::"MaintenanceServiceOrderStatus",
         $7, $8, $9, current_timestamp)`,
      [
        serviceOrderId,
        code,
        ids.request,
        ids.contract,
        ids.entity,
        status,
        new Date("2026-11-12T13:00:00.000Z"),
        ids.authorizedUser,
        `corr-order-execution-${suffix}`
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
         "id", "service_order_id", "line_number", "description", "updated_at"
       ) values
         ($1, $2, 1, 'Manutencao preventiva', current_timestamp),
         ($3, $2, 2, 'Troca de componente', current_timestamp)`,
      [randomUUID(), serviceOrderId, randomUUID()]
    );
  }

  return {
    suffix,
    validServiceOrderId: ids.validServiceOrder,
    invalidStateServiceOrderId: ids.invalidStateServiceOrder,
    unauthorizedServiceOrderId: ids.unauthorizedServiceOrder,
    maintenanceRequestId: ids.request,
    patrimonyIds: [ids.patrimonyOne, ids.patrimonyTwo],
    authorizedUserId: ids.authorizedUser,
    outOfScopeUserId: ids.outOfScopeUser,
    contractItemId: ids.contractItem
  };
}
