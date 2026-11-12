import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { GlosaMaintenanceServiceOrderInput } from "../../src/modules/maintenance/application/glosa-maintenance-service-order";
import { GlosaMaintenanceServiceOrder } from "../../src/modules/maintenance/application/glosa-maintenance-service-order";
import { PostgresMaintenanceServiceOrderGlosser } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-glosser";

const execFileAsync = promisify(execFile);
const GLOSA_ACTION = "maintenance.glosa_service_order";
const GLOSA_EVENT = "maintenance.service_order_glossed";

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("glosa de Ordem de Serviço", () => {
  it("restitui parcialmente saldo por linha, registra ledger e é idempotente", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 4 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();
      const seed = await seedScenario(client);
      const useCase = new GlosaMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderGlosser(pool)
      );
      const command = glosaCommand(seed, [
        { serviceOrderServiceId: seed.firstLineId, quantity: 1 },
        { serviceOrderServiceId: seed.secondLineId, quantity: 2 }
      ]);

      await expect(
        useCase.execute({
          ...command,
          commandId: "cmd-glosa-os-nao-autorizada-001",
          actorUserId: randomUUID(),
          correlationId: "corr-glosa-os-nao-autorizada-001"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        serviceOrderId: seed.serviceOrderId
      });
      await expect(
        useCase.execute({
          ...command,
          commandId: "cmd-glosa-os-excedente-001",
          lines: [
            { serviceOrderServiceId: seed.firstLineId, quantity: 4 },
            { serviceOrderServiceId: seed.secondLineId, quantity: 2 }
          ],
          correlationId: "corr-glosa-os-excedente-001"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "GLOSA_QUANTITY_EXCEEDS_COMMITTED",
        serviceOrderId: seed.serviceOrderId,
        serviceOrderServiceId: seed.firstLineId
      });

      const result = await useCase.execute(command);

      expect(result).toEqual({
        ok: true,
        serviceOrderId: seed.serviceOrderId,
        status: "CONCLUIDA_COM_GLOSA_PARCIAL",
        totalGlosaAmount: "151.00"
      });
      await expectPersistedGlosa(client, seed, {
        status: "CONCLUIDA_COM_GLOSA_PARCIAL",
        totalGlosaAmount: "151.00",
        lines: [
          { id: seed.firstLineId, glosed_quantity: 1, glosed_amount: "100.00" },
          { id: seed.secondLineId, glosed_quantity: 2, glosed_amount: "51.00" }
        ],
        balances: [
          {
            committed_quantity: 2,
            available_quantity: 8,
            committed_amount: "200.00",
            available_amount: "800.00"
          },
          {
            committed_quantity: 0,
            available_quantity: 8,
            committed_amount: "0.00",
            available_amount: "204.00"
          }
        ]
      });

      await expect(useCase.execute(command)).resolves.toEqual(result);
      await expect(
        useCase.execute({
          ...command,
          commandId: "cmd-glosa-os-duplicada-001",
          correlationId: "corr-glosa-os-duplicada-001"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "SERVICE_ORDER_NOT_GLOSSABLE",
        serviceOrderId: seed.serviceOrderId
      });
      await expectPersistedGlosa(client, seed, {
        status: "CONCLUIDA_COM_GLOSA_PARCIAL",
        totalGlosaAmount: "151.00",
        lines: [
          { id: seed.firstLineId, glosed_quantity: 1, glosed_amount: "100.00" },
          { id: seed.secondLineId, glosed_quantity: 2, glosed_amount: "51.00" }
        ],
        balances: [
          {
            committed_quantity: 2,
            available_quantity: 8,
            committed_amount: "200.00",
            available_amount: "800.00"
          },
          {
            committed_quantity: 0,
            available_quantity: 8,
            committed_amount: "0.00",
            available_amount: "204.00"
          }
        ]
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);

  it("restitui totalmente as linhas e preserva a liquidação como fato final", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 4 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();
      const seed = await seedScenario(client);
      const useCase = new GlosaMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderGlosser(pool)
      );
      const command = glosaCommand(seed, [
        { serviceOrderServiceId: seed.firstLineId, quantity: 3 },
        { serviceOrderServiceId: seed.secondLineId, quantity: 2 }
      ]);

      await expect(useCase.execute(command)).resolves.toEqual({
        ok: true,
        serviceOrderId: seed.serviceOrderId,
        status: "CONCLUIDA_COM_GLOSA_TOTAL",
        totalGlosaAmount: "351.00"
      });
      await expectPersistedGlosa(client, seed, {
        status: "CONCLUIDA_COM_GLOSA_TOTAL",
        totalGlosaAmount: "351.00",
        lines: [
          { id: seed.firstLineId, glosed_quantity: 3, glosed_amount: "300.00" },
          { id: seed.secondLineId, glosed_quantity: 2, glosed_amount: "51.00" }
        ],
        balances: [
          {
            committed_quantity: 0,
            available_quantity: 10,
            committed_amount: "0.00",
            available_amount: "1000.00"
          },
          {
            committed_quantity: 0,
            available_quantity: 8,
            committed_amount: "0.00",
            available_amount: "204.00"
          }
        ]
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);

  it("desfaz todas as alterações quando o ledger falha após a primeira linha", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 4 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();
      const seed = await seedScenario(client);
      await client.query(
        `insert into "contract_balance_movement" (
           "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta",
           "occurred_at", "summary"
         ) values ($1, $2, $3, 'COMPROMETIMENTO_OS', -1, -25.50, $4, 'Movimento conflitante de teste')`,
        [
          randomUUID(),
          `${seed.serviceOrderCode}-OS-GL-002`,
          seed.secondContractItemId,
          new Date("2026-11-12T15:00:00.000Z")
        ]
      );
      const useCase = new GlosaMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderGlosser(pool)
      );

      await expect(
        useCase.execute(
          glosaCommand(seed, [
            { serviceOrderServiceId: seed.firstLineId, quantity: 1 },
            { serviceOrderServiceId: seed.secondLineId, quantity: 1 }
          ])
        )
      ).rejects.toMatchObject({ code: "23505" });

      const order = await client.query<{ status: string }>(
        `select "status"::text as "status" from "maintenance_service_order" where "id" = $1`,
        [seed.serviceOrderId]
      );
      const lines = await client.query<{ glosed_quantity: number; glosed_amount: string }>(
        `select "glosed_quantity", "glosed_amount"::text as "glosed_amount"
           from "maintenance_service_order_service"
          where "service_order_id" = $1
          order by "line_number"`,
        [seed.serviceOrderId]
      );
      const balances = await client.query<{
        committed_quantity: number;
        available_quantity: number;
      }>(
        `select "committed_quantity", "available_quantity"
           from "contract_balance_position"
          where "contract_item_id" = any($1::uuid[])
          order by array_position($1::uuid[], "contract_item_id")`,
        [[seed.firstContractItemId, seed.secondContractItemId]]
      );
      const effects = await client.query<{ audits: number; outbox: number; glosas: number }>(
        `select
           (select count(*)::int from "audit_entry" where "action" = $1 and "object_id" = $2) as "audits",
           (select count(*)::int from "outbox_event" where "event_type" = $3 and "aggregate_id" = $2) as "outbox",
           (select count(*)::int from "contract_balance_movement" where "type" = 'GLOSA_OS') as "glosas"`,
        [GLOSA_ACTION, seed.serviceOrderId, GLOSA_EVENT]
      );
      expect(order.rows).toEqual([{ status: "ATESTADA" }]);
      expect(lines.rows).toEqual([
        { glosed_quantity: 0, glosed_amount: "0.00" },
        { glosed_quantity: 0, glosed_amount: "0.00" }
      ]);
      expect(balances.rows).toEqual([
        { committed_quantity: 3, available_quantity: 7 },
        { committed_quantity: 2, available_quantity: 6 }
      ]);
      expect(effects.rows).toEqual([{ audits: 0, outbox: 0, glosas: 0 }]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);

  it("serializa glosas concorrentes no mesmo Item Contratual sem restituir acima do saldo", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 4 });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();
      const seed = await seedScenario(client);
      await client.query(
        `update "maintenance_service_order_service"
            set "quantity" = 1, "total_amount" = 100.00
          where "id" = $1`,
        [seed.firstLineId]
      );
      await client.query(
        `update "contract_balance_position"
            set "committed_quantity" = 1, "available_quantity" = 9,
                "committed_amount" = 100.00, "available_amount" = 900.00
          where "contract_item_id" = $1`,
        [seed.firstContractItemId]
      );
      const sibling = await insertSiblingServiceOrder(client, seed);
      const firstUseCase = new GlosaMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderGlosser(pool)
      );
      const secondUseCase = new GlosaMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderGlosser(pool)
      );

      const [firstResult, secondResult] = await Promise.all([
        firstUseCase.execute({
          ...glosaCommand(seed, [{ serviceOrderServiceId: seed.firstLineId, quantity: 1 }]),
          commandId: "cmd-glosa-concorrente-001",
          correlationId: "corr-glosa-concorrente-001"
        }),
        secondUseCase.execute({
          ...glosaCommand(
            {
              ...seed,
              serviceOrderId: sibling.serviceOrderId,
              serviceOrderCode: sibling.code,
              firstLineId: sibling.lineId
            },
            [{ serviceOrderServiceId: sibling.lineId, quantity: 1 }]
          ),
          commandId: "cmd-glosa-concorrente-002",
          correlationId: "corr-glosa-concorrente-002"
        })
      ]);
      const results = [firstResult, secondResult];

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ reason: "INSUFFICIENT_COMMITTED_CONTRACT_BALANCE" })
      ]);
      const balance = await client.query<{
        committed_quantity: number;
        available_quantity: number;
        committed_amount: string;
        available_amount: string;
      }>(
        `select "committed_quantity", "available_quantity",
                "committed_amount"::text as "committed_amount", "available_amount"::text as "available_amount"
           from "contract_balance_position"
          where "contract_item_id" = $1`,
        [seed.firstContractItemId]
      );
      const movements = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "contract_balance_movement"
          where "type" = 'GLOSA_OS'
            and "contract_item_id" = $1`,
        [seed.firstContractItemId]
      );
      expect(balance.rows).toEqual([
        {
          committed_quantity: 0,
          available_quantity: 10,
          committed_amount: "0.00",
          available_amount: "1000.00"
        }
      ]);
      expect(movements.rows).toEqual([{ count: 1 }]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);
});

type GlosaSeed = {
  serviceOrderId: string;
  serviceOrderCode: string;
  actorUserId: string;
  requestId: string;
  contractId: string;
  entityId: string;
  patrimonyId: string;
  firstLineId: string;
  secondLineId: string;
  firstContractItemId: string;
  secondContractItemId: string;
};

function glosaCommand(
  seed: GlosaSeed,
  lines: Array<{ serviceOrderServiceId: string; quantity: number }>
): GlosaMaintenanceServiceOrderInput {
  return {
    commandId: "cmd-glosa-os-001",
    serviceOrderId: seed.serviceOrderId,
    lines,
    glosaAt: new Date("2026-11-12T16:00:00.000Z"),
    actorUserId: seed.actorUserId,
    teamContext: "Patrimônio",
    correlationId: "corr-glosa-os-001"
  };
}

async function expectPersistedGlosa(
  client: Client,
  seed: GlosaSeed,
  expected: {
    status: string;
    totalGlosaAmount: string;
    lines: Array<{ id: string; glosed_quantity: number; glosed_amount: string }>;
    balances: Array<{
      committed_quantity: number;
      available_quantity: number;
      committed_amount: string;
      available_amount: string;
    }>;
  }
): Promise<void> {
  const order = await client.query<{ status: string }>(
    `select "status"::text as "status" from "maintenance_service_order" where "id" = $1`,
    [seed.serviceOrderId]
  );
  expect(order.rows).toEqual([{ status: expected.status }]);

  const lines = await client.query<{
    id: string;
    glosed_quantity: number;
    glosed_amount: string;
  }>(
    `select "id", "glosed_quantity", "glosed_amount"::text as "glosed_amount"
       from "maintenance_service_order_service"
      where "service_order_id" = $1
      order by "line_number"`,
    [seed.serviceOrderId]
  );
  expect(lines.rows).toEqual(expected.lines);

  const movements = await client.query<{
    type: string;
    quantity_delta: number;
    amount_delta: string;
    maintenance_service_order_service_id: string;
  }>(
    `select "type"::text as "type", "quantity_delta", "amount_delta"::text as "amount_delta",
            "maintenance_service_order_service_id"
       from "contract_balance_movement"
      where "type" = 'GLOSA_OS'
      order by "code"`,
    []
  );
  expect(movements.rows).toHaveLength(2);
  expect(movements.rows).toEqual(
    expected.lines.map((line) => ({
      type: "GLOSA_OS",
      quantity_delta: line.glosed_quantity,
      amount_delta: line.glosed_amount,
      maintenance_service_order_service_id: line.id
    }))
  );

  const balances = await client.query<{
    contract_item_id: string;
    committed_quantity: number;
    available_quantity: number;
    committed_amount: string;
    available_amount: string;
  }>(
    `select "contract_item_id", "committed_quantity", "available_quantity",
            "committed_amount"::text as "committed_amount", "available_amount"::text as "available_amount"
       from "contract_balance_position"
      where "contract_item_id" = any($1::uuid[])
      order by array_position($1::uuid[], "contract_item_id")`,
    [[seed.firstContractItemId, seed.secondContractItemId]]
  );
  expect(
    balances.rows.map((balance) => ({
      committed_quantity: balance.committed_quantity,
      available_quantity: balance.available_quantity,
      committed_amount: balance.committed_amount,
      available_amount: balance.available_amount
    }))
  ).toEqual(expected.balances);

  const audit = await client.query<{
    actor_user_id: string;
    correlation_id: string;
    next_value: unknown;
  }>(
    `select "actor_user_id", "correlation_id", "next_value"
       from "audit_entry"
      where "action" = $1 and "object_id" = $2`,
    [GLOSA_ACTION, seed.serviceOrderId]
  );
  const outbox = await client.query<{ payload: unknown }>(
    `select "payload"
       from "outbox_event"
      where "event_type" = $1 and "aggregate_id" = $2`,
    [GLOSA_EVENT, seed.serviceOrderId]
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    actor_user_id: seed.actorUserId,
    correlation_id: "corr-glosa-os-001",
    next_value: expect.objectContaining({
      status: expected.status,
      totalGlosaAmount: expected.totalGlosaAmount
    })
  });
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0].payload).toMatchObject({
    serviceOrderId: seed.serviceOrderId,
    status: expected.status,
    totalGlosaAmount: expected.totalGlosaAmount
  });
  expect(expected.totalGlosaAmount).toMatch(/^\d+\.\d{2}$/);
}

async function seedScenario(client: Client): Promise<GlosaSeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const ids = {
    gre: randomUUID(),
    entity: randomUUID(),
    materialClass: randomUUID(),
    material: randomUUID(),
    patrimony: randomUUID(),
    person: randomUUID(),
    user: randomUUID(),
    team: randomUUID(),
    supplier: randomUUID(),
    contract: randomUUID(),
    firstItem: randomUUID(),
    secondItem: randomUUID(),
    request: randomUUID(),
    serviceOrder: randomUUID(),
    firstLine: randomUUID(),
    secondLine: randomUUID()
  };
  const greCode = `GRE-GLOSA-${suffix}`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values ($1, $2, 'GRE de glosa', current_timestamp)`,
    [ids.gre, greCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, $2, 'Entidade de glosa', 'ESCOLA', $3, current_timestamp)`,
    [ids.entity, `ENT-GLOSA-${suffix}`, ids.gre]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Classe de glosa', current_timestamp)`,
    [ids.materialClass, `CLS-GLOSA-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Material de glosa', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [ids.material, `MAT-GLOSA-${suffix}`, ids.materialClass]
  );
  await client.query(
    `insert into "patrimony" ("id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at")
     values ($1, $2, $3, 'EM_USO', current_timestamp)`,
    [ids.patrimony, ids.material, ids.entity]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values ($1, 'Usuário de Glosa', current_timestamp)`,
    [ids.person]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values ($1, $2, $3, 'ACTIVE', false, current_timestamp)`,
    [ids.user, ids.person, `patrimonio.glosa.${suffix.toLowerCase()}@gmap.test`]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values ($1, 'Patrimônio', current_timestamp)`,
    [ids.team]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
     ) values ($1, $2, $3, 'MEMBRO', 'GRE', $4, true, current_timestamp)`,
    [randomUUID(), ids.user, ids.team, greCode]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at") values ($1, $2, 'Prestador de glosa', current_timestamp)`,
    [ids.supplier, `FORN-GLOSA-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de glosa', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-GLOSA-${suffix}`, ids.supplier]
  );
  await insertContractItem(
    client,
    ids.firstItem,
    `CTR-GLOSA-${suffix}-ITEM-001`,
    ids.contract,
    1,
    "100.00",
    10,
    "1000.00",
    3,
    "300.00",
    7,
    "700.00"
  );
  await insertContractItem(
    client,
    ids.secondItem,
    `CTR-GLOSA-${suffix}-ITEM-002`,
    ids.contract,
    2,
    "25.50",
    8,
    "204.00",
    2,
    "51.00",
    6,
    "153.00"
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version", "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitação de glosa', 'Solicitação para teste de glosa',
       '2026-11-12T10:00:00.000Z', '2026-11-12T11:00:00.000Z', $3, 'Autorização da Gerência', 2, $4, current_timestamp)`,
    [ids.request, ids.entity, ids.user, `corr-request-glosa-${suffix}`]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, '2026-11-12T12:00:00.000Z', $4, $5, current_timestamp)`,
    [randomUUID(), ids.request, ids.patrimony, ids.user, `corr-target-glosa-${suffix}`]
  );
  await client.query(
    `insert into "maintenance_service_order" (
       "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
       "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, 'ATESTADA', '2026-11-12T13:00:00.000Z', $6, $7, current_timestamp)`,
    [
      ids.serviceOrder,
      `OS-GLOSA-${suffix}`,
      ids.request,
      ids.contract,
      ids.entity,
      ids.user,
      `corr-os-glosa-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_service_order_patrimony" (
       "id", "service_order_id", "maintenance_request_id", "patrimony_id"
     ) values ($1, $2, $3, $4)`,
    [randomUUID(), ids.serviceOrder, ids.request, ids.patrimony]
  );
  await client.query(
    `insert into "maintenance_service_order_service" (
       "id", "service_order_id", "contract_item_id", "line_number", "description",
       "quantity", "unit_price", "total_amount", "updated_at"
     ) values
       ($1, $2, $3, 1, 'Diagnóstico', 3, 100.00, 300.00, current_timestamp),
       ($4, $2, $5, 2, 'Substituição', 2, 25.50, 51.00, current_timestamp)`,
    [ids.firstLine, ids.serviceOrder, ids.firstItem, ids.secondLine, ids.secondItem]
  );

  return {
    serviceOrderId: ids.serviceOrder,
    serviceOrderCode: `OS-GLOSA-${suffix}`,
    actorUserId: ids.user,
    requestId: ids.request,
    contractId: ids.contract,
    entityId: ids.entity,
    patrimonyId: ids.patrimony,
    firstLineId: ids.firstLine,
    secondLineId: ids.secondLine,
    firstContractItemId: ids.firstItem,
    secondContractItemId: ids.secondItem
  };
}

async function insertSiblingServiceOrder(
  client: Client,
  seed: GlosaSeed
): Promise<{ serviceOrderId: string; code: string; lineId: string }> {
  const serviceOrderId = randomUUID();
  const lineId = randomUUID();
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const code = `OS-GLOSA-CONC-${suffix}`;

  await client.query(
    `insert into "maintenance_service_order" (
       "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
       "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, 'ATESTADA', '2026-11-12T13:30:00.000Z', $6, $7, current_timestamp)`,
    [
      serviceOrderId,
      code,
      seed.requestId,
      seed.contractId,
      seed.entityId,
      seed.actorUserId,
      `corr-${code}`
    ]
  );
  await client.query(
    `insert into "maintenance_service_order_patrimony" (
       "id", "service_order_id", "maintenance_request_id", "patrimony_id"
     ) values ($1, $2, $3, $4)`,
    [randomUUID(), serviceOrderId, seed.requestId, seed.patrimonyId]
  );
  await client.query(
    `insert into "maintenance_service_order_service" (
       "id", "service_order_id", "contract_item_id", "line_number", "description",
       "quantity", "unit_price", "total_amount", "updated_at"
     ) values ($1, $2, $3, 1, 'Diagnóstico concorrente', 1, 100.00, 100.00, current_timestamp)`,
    [lineId, serviceOrderId, seed.firstContractItemId]
  );

  return { serviceOrderId, code, lineId };
}

async function insertContractItem(
  client: Client,
  id: string,
  code: string,
  contractId: string,
  lineNumber: number,
  unitPrice: string,
  totalQuantity: number,
  totalAmount: string,
  committedQuantity: number,
  committedAmount: string,
  availableQuantity: number,
  availableAmount: string
): Promise<void> {
  await client.query(
    `insert into "contract_item" (
       "id", "code", "contract_id", "line_number", "material_singular_id",
       "contracted_quantity", "unit_price", "updated_at"
     ) values ($1, $2, $3, $4, (select "id" from "material_singular" limit 1), $5, $6, current_timestamp)`,
    [id, code, contractId, lineNumber, totalQuantity, unitPrice]
  );
  await client.query(
    `insert into "contract_balance_position" (
       "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
       "total_amount", "committed_amount", "available_amount", "version", "updated_at"
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 1, current_timestamp)`,
    [
      randomUUID(),
      id,
      totalQuantity,
      committedQuantity,
      availableQuantity,
      totalAmount,
      committedAmount,
      availableAmount
    ]
  );
}
