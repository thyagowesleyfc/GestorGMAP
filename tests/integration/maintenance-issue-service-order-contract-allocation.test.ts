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

describe("emissão de OS com alocação contratual por linha", () => {
  it("congela preços, compromete todas as linhas atomicamente e é idempotente", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 4 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = new IssueMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderIssuer(pool)
      );
      const command = issueCommand(seed);

      const issued = await executeAllocation(useCase, command);

      expect(issued).toMatchObject({
        ok: true,
        code: command.code,
        contractId: seed.contractId,
        serviceCount: 2,
        status: "EMITIDA"
      });
      if (!issued.ok) {
        throw new Error("A emissão com alocação contratual deveria ter sido aceita.");
      }

      await expectFrozenServiceLines(client, issued.serviceOrderId, seed, command);
      await expectCommittedBalances(client, seed);
      await expectOsBalanceMovements(client, issued.serviceOrderId, seed, command);
      await expectAuditAndOutbox(client, issued.serviceOrderId, command);

      await expect(executeAllocation(useCase, command)).resolves.toEqual(issued);
      await expectSingleEmission(client, issued.serviceOrderId, seed);

      const conflict = await executeAllocation(useCase, {
        ...command,
        code: `${command.code}-ALTERADA`
      });
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectSingleEmission(client, issued.serviceOrderId, seed);

      const beforeInsufficient = await takeSnapshot(client, seed);
      const insufficient = await executeAllocation(useCase, {
        ...command,
        commandId: "cmd-os-alocacao-insuficiente-001",
        code: `${command.code}-INSUFICIENTE`,
        services: [
          command.services[0],
          {
            description: "Linha acima do saldo disponível",
            contractItemId: seed.secondContractItemId,
            quantity: 99
          }
        ]
      });

      expect(insufficient).toEqual({
        ok: false,
        reason: "INSUFFICIENT_CONTRACT_BALANCE",
        contractItemId: seed.secondContractItemId
      });
      expect(await takeSnapshot(client, seed)).toEqual(beforeInsufficient);

      const crossContract = await executeAllocation(useCase, {
        ...command,
        commandId: "cmd-os-alocacao-contrato-divergente-001",
        code: `${command.code}-CONTRATO-DIVERGENTE`,
        services: [
          {
            description: "Linha de outro contrato",
            contractItemId: seed.foreignContractItemId,
            quantity: 1
          }
        ]
      });

      expect(crossContract.ok).toBe(false);
      expect(await takeSnapshot(client, seed)).toEqual(beforeInsufficient);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);
});

type ContractAllocationServiceInput = {
  description: string;
  contractItemId: string;
  quantity: number;
};

type ContractAllocationCommand = Omit<IssueMaintenanceServiceOrderInput, "services"> & {
  services: ContractAllocationServiceInput[];
};

type ServiceOrderSeed = {
  suffix: string;
  entityId: string;
  requestId: string;
  patrimonyId: string;
  actorUserId: string;
  contractId: string;
  firstContractItemId: string;
  secondContractItemId: string;
  foreignContractItemId: string;
};

function issueCommand(seed: ServiceOrderSeed): ContractAllocationCommand {
  return {
    commandId: "cmd-os-alocacao-contratual-001",
    code: `OS-${seed.suffix}-ALOCADA`,
    maintenanceRequestId: seed.requestId,
    contractId: seed.contractId,
    entityId: seed.entityId,
    patrimonyIds: [seed.patrimonyId],
    services: [
      {
        description: "Diagnóstico do equipamento",
        contractItemId: seed.firstContractItemId,
        quantity: 3
      },
      {
        description: "Substituição do componente",
        contractItemId: seed.secondContractItemId,
        quantity: 2
      }
    ],
    issuedAt: new Date("2026-11-12T14:00:00.000Z"),
    actorUserId: seed.actorUserId,
    teamContext: "Patrimônio",
    correlationId: "corr-os-alocacao-contratual-001"
  };
}

async function executeAllocation(
  useCase: IssueMaintenanceServiceOrder,
  command: ContractAllocationCommand
) {
  return useCase.execute(command as unknown as IssueMaintenanceServiceOrderInput);
}

async function expectFrozenServiceLines(
  client: Client,
  serviceOrderId: string,
  seed: ServiceOrderSeed,
  command: ContractAllocationCommand
): Promise<void> {
  const result = await client.query<{
    line_number: number;
    description: string;
    contract_item_id: string;
    quantity: number;
    unit_price: string;
    total_amount: string;
  }>(
    `select "line_number", "description", "contract_item_id", "quantity",
            "unit_price"::text, "total_amount"::text
       from "maintenance_service_order_service"
      where "service_order_id" = $1
      order by "line_number"`,
    [serviceOrderId]
  );

  expect(result.rows).toEqual([
    {
      line_number: 1,
      description: command.services[0].description,
      contract_item_id: seed.firstContractItemId,
      quantity: 3,
      unit_price: "100.00",
      total_amount: "300.00"
    },
    {
      line_number: 2,
      description: command.services[1].description,
      contract_item_id: seed.secondContractItemId,
      quantity: 2,
      unit_price: "25.50",
      total_amount: "51.00"
    }
  ]);
}

async function expectCommittedBalances(client: Client, seed: ServiceOrderSeed): Promise<void> {
  const result = await client.query<{
    contract_item_id: string;
    committed_quantity: number;
    available_quantity: number;
    committed_amount: string;
    available_amount: string;
  }>(
    `select "contract_item_id", "committed_quantity", "available_quantity",
            "committed_amount"::text, "available_amount"::text
       from "contract_balance_position"
      where "contract_item_id" = any($1::uuid[])
      order by "contract_item_id"`,
    [[seed.firstContractItemId, seed.secondContractItemId]]
  );

  expect(result.rows).toEqual(
    [
      {
        contract_item_id: seed.firstContractItemId,
        committed_quantity: 3,
        available_quantity: 7,
        committed_amount: "300.00",
        available_amount: "700.00"
      },
      {
        contract_item_id: seed.secondContractItemId,
        committed_quantity: 2,
        available_quantity: 6,
        committed_amount: "51.00",
        available_amount: "153.00"
      }
    ].sort((left, right) => left.contract_item_id.localeCompare(right.contract_item_id))
  );
}

async function expectOsBalanceMovements(
  client: Client,
  serviceOrderId: string,
  seed: ServiceOrderSeed,
  command: ContractAllocationCommand
): Promise<void> {
  const result = await client.query<{
    contract_item_id: string;
    type: string;
    quantity_delta: number;
    amount_delta: string;
    service_order_id: string;
    service_order_line_number: number;
  }>(
    `select m."contract_item_id", m."type"::text as "type", m."quantity_delta",
            m."amount_delta"::text, s."service_order_id",
            s."line_number" as "service_order_line_number"
       from "contract_balance_movement" m
       join "maintenance_service_order_service" s
         on s."id" = m."maintenance_service_order_service_id"
      where s."service_order_id" = $1
      order by s."line_number"`,
    [serviceOrderId]
  );

  expect(result.rows).toEqual([
    {
      contract_item_id: seed.firstContractItemId,
      type: "COMPROMETIMENTO_OS",
      quantity_delta: -command.services[0].quantity,
      amount_delta: "-300.00",
      service_order_id: serviceOrderId,
      service_order_line_number: 1
    },
    {
      contract_item_id: seed.secondContractItemId,
      type: "COMPROMETIMENTO_OS",
      quantity_delta: -command.services[1].quantity,
      amount_delta: "-51.00",
      service_order_id: serviceOrderId,
      service_order_line_number: 2
    }
  ]);
}

async function expectAuditAndOutbox(
  client: Client,
  serviceOrderId: string,
  command: ContractAllocationCommand
): Promise<void> {
  const audit = await client.query<{ action: string; object_id: string; next_value: unknown }>(
    `select "action", "object_id", "next_value"
       from "audit_entry"
      where "action" = $1
        and "object_id" = $2`,
    [ISSUE_SERVICE_ORDER_ACTION, serviceOrderId]
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    action: ISSUE_SERVICE_ORDER_ACTION,
    object_id: serviceOrderId,
    next_value: expect.objectContaining({
      services: expect.arrayContaining([
        expect.objectContaining({
          contractItemId: command.services[0].contractItemId,
          quantity: 3
        }),
        expect.objectContaining({ contractItemId: command.services[1].contractItemId, quantity: 2 })
      ])
    })
  });

  const outbox = await client.query<{ event_type: string; aggregate_id: string; payload: unknown }>(
    `select "event_type", "aggregate_id", "payload"
       from "outbox_event"
      where "event_type" = $1
        and "aggregate_id" = $2`,
    [SERVICE_ORDER_ISSUED_EVENT, serviceOrderId]
  );
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0]).toMatchObject({
    event_type: SERVICE_ORDER_ISSUED_EVENT,
    aggregate_id: serviceOrderId,
    payload: expect.objectContaining({
      serviceOrderId,
      services: expect.arrayContaining([
        expect.objectContaining({
          contractItemId: command.services[0].contractItemId,
          quantity: 3
        }),
        expect.objectContaining({ contractItemId: command.services[1].contractItemId, quantity: 2 })
      ])
    })
  });
}

async function expectSingleEmission(
  client: Client,
  serviceOrderId: string,
  seed: ServiceOrderSeed
): Promise<void> {
  const counts = await client.query<{ orders: number; lines: number; movements: number }>(
    `select
       (select count(*)::int from "maintenance_service_order") as "orders",
       (select count(*)::int from "maintenance_service_order_service") as "lines",
       (select count(*)::int from "contract_balance_movement"
          where "contract_item_id" = any($1::uuid[])) as "movements"`,
    [[seed.firstContractItemId, seed.secondContractItemId]]
  );

  expect(counts.rows).toEqual([{ orders: 1, lines: 2, movements: 2 }]);
  expect(serviceOrderId).toEqual(expect.any(String));
}

async function takeSnapshot(
  client: Client,
  seed: ServiceOrderSeed
): Promise<{
  orders: number;
  lines: number;
  balances: Array<{
    contract_item_id: string;
    committed_quantity: number;
    available_quantity: number;
    committed_amount: string;
    available_amount: string;
  }>;
  movements: number;
  audits: number;
  outbox: number;
}> {
  const counts = await client.query<{
    orders: number;
    lines: number;
    movements: number;
    audits: number;
    outbox: number;
  }>(
    `select
       (select count(*)::int from "maintenance_service_order") as "orders",
       (select count(*)::int from "maintenance_service_order_service") as "lines",
       (select count(*)::int from "contract_balance_movement"
          where "contract_item_id" = any($1::uuid[])) as "movements",
       (select count(*)::int from "audit_entry" where "action" = $2) as "audits",
       (select count(*)::int from "outbox_event" where "event_type" = $3) as "outbox"`,
    [
      [seed.firstContractItemId, seed.secondContractItemId, seed.foreignContractItemId],
      ISSUE_SERVICE_ORDER_ACTION,
      SERVICE_ORDER_ISSUED_EVENT
    ]
  );
  const balances = await client.query<{
    contract_item_id: string;
    committed_quantity: number;
    available_quantity: number;
    committed_amount: string;
    available_amount: string;
  }>(
    `select "contract_item_id", "committed_quantity", "available_quantity",
            "committed_amount"::text, "available_amount"::text
       from "contract_balance_position"
      where "contract_item_id" = any($1::uuid[])
      order by "contract_item_id"`,
    [[seed.firstContractItemId, seed.secondContractItemId, seed.foreignContractItemId]]
  );

  return { ...counts.rows[0], balances: balances.rows };
}

async function seedDependencies(client: Client): Promise<ServiceOrderSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const greCode = `GRE-OS-ALOC-${suffix}`;
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialId = randomUUID();
  const patrimonyId = randomUUID();
  const requestId = randomUUID();
  const actorUserId = randomUUID();
  const actorPersonId = randomUUID();
  const patrimonyTeamId = randomUUID();
  const supplierId = randomUUID();
  const contractId = randomUUID();
  const foreignContractId = randomUUID();
  const firstContractItemId = randomUUID();
  const secondContractItemId = randomUUID();
  const foreignContractItemId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE de manutenção', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, $2, 'Entidade solicitante', 'ESCOLA', $3, current_timestamp)`,
    [entityId, `ENT-OS-ALOC-${suffix}`, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informática', current_timestamp)`,
    [materialClassId, `CLS-OS-ALOC-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Componente de manutenção', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, `MAT-OS-ALOC-${suffix}`, materialClassId]
  );
  await client.query(
    `insert into "patrimony" (
       "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
     ) values ($1, $2, $3, 'EM_USO', current_timestamp)`,
    [patrimonyId, materialId, entityId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário de Patrimônio', current_timestamp)`,
    [actorPersonId]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values ($1, $2, $3, 'ACTIVE', false, current_timestamp)`,
    [actorUserId, actorPersonId, `patrimonio.alocacao.${suffix.toLowerCase()}@gmap.test`]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Patrimônio', current_timestamp)`,
    [patrimonyTeamId]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
     ) values ($1, $2, $3, 'MEMBRO', 'GRE', $4, true, current_timestamp)`,
    [randomUUID(), actorUserId, patrimonyTeamId, greCode]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de manutenção', current_timestamp)`,
    [supplierId, `FORN-OS-ALOC-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values
       ($1, $2, $3, 'Contrato de serviço', '2026-01-01', '2026-12-31', true, current_timestamp),
       ($4, $5, $3, 'Outro contrato de serviço', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [
      contractId,
      `CTR-OS-ALOC-${suffix}`,
      supplierId,
      foreignContractId,
      `CTR-OS-ALOC-OUTRO-${suffix}`
    ]
  );

  await insertContractItem(client, {
    id: firstContractItemId,
    contractId,
    code: `CTR-OS-ALOC-${suffix}-ITEM-001`,
    lineNumber: 1,
    quantity: 10,
    unitPrice: "100.00",
    amount: "1000.00"
  });
  await insertContractItem(client, {
    id: secondContractItemId,
    contractId,
    code: `CTR-OS-ALOC-${suffix}-ITEM-002`,
    lineNumber: 2,
    quantity: 8,
    unitPrice: "25.50",
    amount: "204.00"
  });
  await insertContractItem(client, {
    id: foreignContractItemId,
    contractId: foreignContractId,
    code: `CTR-OS-ALOC-${suffix}-OUTRO-001`,
    lineNumber: 1,
    quantity: 10,
    unitPrice: "10.00",
    amount: "100.00"
  });

  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version", "correlation_id",
       "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitação de manutenção', 'Solicitação para teste de alocação',
       '2026-11-12T10:00:00.000Z', '2026-11-12T11:00:00.000Z', $3,
       'Autorização da Gerência', 2, $4, current_timestamp)`,
    [requestId, entityId, actorUserId, `corr-request-os-alocacao-${suffix}`]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
       "correlation_id", "updated_at"
     ) values ($1, $2, $3, '2026-11-12T12:00:00.000Z', $4, $5, current_timestamp)`,
    [randomUUID(), requestId, patrimonyId, actorUserId, `corr-target-os-alocacao-${suffix}`]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_strategy" (
       "id", "maintenance_request_id", "patrimony_id", "strategy_type", "contract_id",
       "justification", "defined_at", "defined_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, 'CONTRATO_SERVICO', $4, 'Atendimento coberto por contrato vigente.',
       '2026-11-12T12:15:00.000Z', $5, $6, current_timestamp)`,
    [
      randomUUID(),
      requestId,
      patrimonyId,
      contractId,
      actorUserId,
      `corr-strategy-os-alocacao-${suffix}`
    ]
  );

  return {
    suffix,
    entityId,
    requestId,
    patrimonyId,
    actorUserId,
    contractId,
    firstContractItemId,
    secondContractItemId,
    foreignContractItemId
  };
}

async function insertContractItem(
  client: Client,
  input: {
    id: string;
    contractId: string;
    code: string;
    lineNumber: number;
    quantity: number;
    unitPrice: string;
    amount: string;
  }
): Promise<void> {
  await client.query(
    `insert into "contract_item" (
       "id", "code", "contract_id", "line_number", "material_singular_id",
       "contracted_quantity", "unit_price", "updated_at"
     ) values ($1, $2, $3, $4, (select "id" from "material_singular" limit 1), $5, $6, current_timestamp)`,
    [input.id, input.code, input.contractId, input.lineNumber, input.quantity, input.unitPrice]
  );
  await client.query(
    `insert into "contract_balance_position" (
       "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
       "total_amount", "committed_amount", "available_amount", "version", "updated_at"
     ) values ($1, $2, $3, 0, $3, $4, 0, $4, 1, current_timestamp)`,
    [randomUUID(), input.id, input.quantity, input.amount]
  );
}
