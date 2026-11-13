import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { GlosaMaintenanceServiceOrder } from "../../src/modules/maintenance/application/glosa-maintenance-service-order";
import { handleGlosaMaintenanceServiceOrderRequest } from "../../src/modules/maintenance/api/glosa-maintenance-service-order-route";
import { PostgresMaintenanceServiceOrderGlosser } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-glosser";
import { PrismaAuthenticatedUserContextReader } from "../../src/modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { ResolveAuthenticatedSession } from "../../src/modules/organization/application/resolve-authenticated-session";
import { PrismaSessionStore } from "../../src/modules/organization/infrastructure/session/prisma-session-store";
import { hashSessionToken } from "../../src/modules/organization/infrastructure/session/session-token";
import { withApiObservability } from "../../src/shared/observability/api";

const execFileAsync = promisify(execFile);
const GLOSA_ACTION = "maintenance.glosa_service_order";
const SERVICE_ORDER_GLOSSED_EVENT = "maintenance.service_order_glossed";

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("rota HTTP de glosa da Ordem de Serviço", () => {
  it("autentica por sessão, persiste a glosa e faz replay HTTP idempotente", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const connectionString = postgres.getConnectionUri();
    const client = new Client({ connectionString });
    const pool = new Pool({ connectionString, max: 4 });
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: connectionString
        }
      }
    });

    try {
      await runPrismaMigrateDeploy(connectionString);
      await client.connect();

      const seed = await seedDependencies(client);
      const sessionToken = `session-glosa-route-${seed.suffix}`;
      await insertSession(client, seed.authorizedUserId, sessionToken);

      const resolveSession = new ResolveAuthenticatedSession(
        new PrismaSessionStore(prisma),
        new PrismaAuthenticatedUserContextReader(prisma)
      );
      const glosaServiceOrder = new GlosaMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderGlosser(pool)
      );
      const dependencies = { resolveSession, glosaServiceOrder };
      const body = {
        commandId: `cmd-maintenance-glosa-service-order-route-${seed.suffix}`,
        lines: [{ serviceOrderServiceId: seed.serviceOrderServiceId, quantity: 1 }],
        glosaAt: "2026-11-13T16:00:00.000Z"
      };
      const requestUrl = `http://localhost/api/maintenance/service-orders/${seed.serviceOrderId}/glosa`;
      const correlationId = `corr-maintenance-glosa-service-order-route-${seed.suffix}`;
      const requestHeaders = {
        "content-type": "application/json",
        cookie: `gmap_session=${sessionToken}`,
        origin: "http://localhost",
        "x-correlation-id": correlationId
      };
      const post = async () =>
        withApiObservability(
          new Request(requestUrl, {
            body: JSON.stringify(body),
            headers: requestHeaders,
            method: "POST"
          }),
          "/api/maintenance/service-orders/{serviceOrderId}/glosa",
          ({ correlationId: requestCorrelationId, request }) =>
            handleGlosaMaintenanceServiceOrderRequest(
              request,
              {
                serviceOrderId: seed.serviceOrderId,
                correlationId: requestCorrelationId
              },
              dependencies
            )
        );

      const firstResponse = await post();
      const firstPayload = await firstResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(firstPayload).toEqual({
        ok: true,
        service_order_id: seed.serviceOrderId,
        status: "CONCLUIDA_COM_GLOSA_PARCIAL",
        total_glosa_amount: "100.00"
      });
      expect(firstResponse.headers.get("x-correlation-id")).toBe(correlationId);

      const secondResponse = await post();
      const secondPayload = await secondResponse.json();

      expect(secondResponse.status).toBe(200);
      expect(secondPayload).toEqual(firstPayload);

      const serviceOrder = await client.query<{ status: string }>(
        `select "status"::text as "status"
           from "maintenance_service_order"
          where "id" = $1`,
        [seed.serviceOrderId]
      );
      expect(serviceOrder.rows).toEqual([{ status: "CONCLUIDA_COM_GLOSA_PARCIAL" }]);

      const serviceLine = await client.query<{
        glosed_quantity: number;
        glosed_amount: string;
      }>(
        `select "glosed_quantity", "glosed_amount"::text as "glosed_amount"
           from "maintenance_service_order_service"
          where "id" = $1`,
        [seed.serviceOrderServiceId]
      );
      expect(serviceLine.rows).toEqual([{ glosed_quantity: 1, glosed_amount: "100.00" }]);

      const balance = await client.query<{
        committed_quantity: number;
        available_quantity: number;
        committed_amount: string;
        available_amount: string;
      }>(
        `select "committed_quantity", "available_quantity",
                "committed_amount"::text as "committed_amount",
                "available_amount"::text as "available_amount"
           from "contract_balance_position"
          where "contract_item_id" = $1`,
        [seed.contractItemId]
      );
      expect(balance.rows).toEqual([
        {
          committed_quantity: 2,
          available_quantity: 8,
          committed_amount: "200.00",
          available_amount: "800.00"
        }
      ]);

      const idempotency = await client.query<{
        status: string;
        result_json: {
          ok?: boolean;
          serviceOrderId?: string;
          status?: string;
          totalGlosaAmount?: string;
        };
      }>(
        `select "status"::text as "status", "result_json"
           from "command_idempotency"
          where "command_name" = $1
            and "idempotency_key" = $2`,
        [GLOSA_ACTION, body.commandId]
      );
      expect(idempotency.rows).toHaveLength(1);
      expect(idempotency.rows[0]).toMatchObject({
        status: "SUCCEEDED",
        result_json: {
          ok: true,
          serviceOrderId: seed.serviceOrderId,
          status: "CONCLUIDA_COM_GLOSA_PARCIAL",
          totalGlosaAmount: "100.00"
        }
      });

      const effects = await client.query<{
        audits: number;
        outbox: number;
        movements: number;
        actor_user_id: string;
        team_context: string;
        correlation_id: string;
      }>(
        `select
           (select count(*)::int
              from "audit_entry"
             where "action" = $1 and "object_id" = $2) as "audits",
           (select count(*)::int
              from "outbox_event"
             where "event_type" = $3 and "aggregate_id" = $2) as "outbox",
           (select count(*)::int
              from "contract_balance_movement"
             where "type" = 'GLOSA_OS'
               and "maintenance_service_order_service_id" = $4) as "movements",
           (select "actor_user_id"
              from "audit_entry"
             where "action" = $1 and "object_id" = $2
             limit 1) as "actor_user_id",
           (select "team_context"
              from "audit_entry"
             where "action" = $1 and "object_id" = $2
             limit 1) as "team_context",
           (select "correlation_id"
              from "audit_entry"
             where "action" = $1 and "object_id" = $2
             limit 1) as "correlation_id"`,
        [GLOSA_ACTION, seed.serviceOrderId, SERVICE_ORDER_GLOSSED_EVENT, seed.serviceOrderServiceId]
      );
      expect(effects.rows).toEqual([
        {
          audits: 1,
          outbox: 1,
          movements: 1,
          actor_user_id: seed.authorizedUserId,
          team_context: "Patrimônio",
          correlation_id: correlationId
        }
      ]);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 120000);
});

type ServiceOrderSeed = {
  suffix: string;
  serviceOrderId: string;
  serviceOrderServiceId: string;
  contractItemId: string;
  authorizedUserId: string;
};

async function insertSession(client: Client, userId: string, token: string): Promise<void> {
  await client.query(
    `insert into "user_session" (
       "id", "user_id", "session_token_hash", "expires_at", "last_seen_at", "updated_at"
     ) values ($1, $2, $3, $4, $5, current_timestamp)`,
    [
      randomUUID(),
      userId,
      hashSessionToken(token),
      new Date("2026-11-14T00:00:00.000Z"),
      new Date("2026-11-13T12:00:00.000Z")
    ]
  );
}

async function seedDependencies(client: Client): Promise<ServiceOrderSeed> {
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
    contractItem: randomUUID(),
    request: randomUUID(),
    serviceOrder: randomUUID(),
    serviceOrderService: randomUUID()
  };

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE de glosa HTTP', current_timestamp)`,
    [ids.gre, `GRE-GLOSA-ROUTE-${suffix}`]
  );
  await client.query(
    `insert into "entity" (
       "id", "code", "name", "entity_type", "gre_id", "updated_at"
     ) values ($1, $2, 'Entidade de glosa HTTP', 'ESCOLA', $3, current_timestamp)`,
    [ids.entity, `ENT-GLOSA-ROUTE-${suffix}`, ids.gre]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Classe de glosa HTTP', current_timestamp)`,
    [ids.materialClass, `CLS-GLOSA-ROUTE-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Material de glosa HTTP', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [ids.material, `MAT-GLOSA-ROUTE-${suffix}`, ids.materialClass]
  );
  await client.query(
    `insert into "patrimony" (
       "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
     ) values ($1, $2, $3, 'EM_USO', current_timestamp)`,
    [ids.patrimony, ids.material, ids.entity]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Operador autorizado da glosa HTTP', current_timestamp)`,
    [ids.person]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values ($1, $2, $3, 'ACTIVE', false, current_timestamp)`,
    [ids.user, ids.person, `authorized.glosa.route.${suffix.toLowerCase()}@gmap.test`]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Patrimônio', current_timestamp)`,
    [ids.team]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "active", "updated_at"
     ) values ($1, $2, $3, 'MEMBRO', 'GLOBAL', true, current_timestamp)`,
    [randomUUID(), ids.user, ids.team]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de glosa HTTP', current_timestamp)`,
    [ids.supplier, `FORN-GLOSA-ROUTE-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de glosa HTTP', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-GLOSA-ROUTE-${suffix}`, ids.supplier]
  );
  await client.query(
    `insert into "contract_item" (
       "id", "code", "contract_id", "line_number", "material_singular_id",
       "contracted_quantity", "unit_price", "updated_at"
     ) values ($1, $2, $3, 1, $4, 10, 100.00, current_timestamp)`,
    [ids.contractItem, `CTR-GLOSA-ROUTE-${suffix}-ITEM-001`, ids.contract, ids.material]
  );
  await client.query(
    `insert into "contract_balance_position" (
       "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
       "total_amount", "committed_amount", "available_amount", "version", "updated_at"
     ) values ($1, $2, 10, 3, 7, 1000.00, 300.00, 700.00, 1, current_timestamp)`,
    [randomUUID(), ids.contractItem]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version",
       "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitação de glosa HTTP', 'Descrição de teste', $3,
       $3, $4, 'Autorização para teste HTTP', 1, $5, current_timestamp)`,
    [
      ids.request,
      ids.entity,
      new Date("2026-11-13T12:00:00.000Z"),
      ids.user,
      `corr-maintenance-request-glosa-route-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
       "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      randomUUID(),
      ids.request,
      ids.patrimony,
      new Date("2026-11-13T12:05:00.000Z"),
      ids.user,
      `corr-maintenance-target-glosa-route-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_service_order" (
       "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
       "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, 'EXECUTADA', $6, $7, $8, current_timestamp)`,
    [
      ids.serviceOrder,
      `OS-GLOSA-ROUTE-${suffix}`,
      ids.request,
      ids.contract,
      ids.entity,
      new Date("2026-11-13T13:00:00.000Z"),
      ids.user,
      `corr-maintenance-service-order-glosa-route-${suffix}`
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
     ) values ($1, $2, $3, 1, 'Diagnóstico de glosa HTTP', 3, 100.00, 300.00, current_timestamp)`,
    [ids.serviceOrderService, ids.serviceOrder, ids.contractItem]
  );
  await client.query(
    `insert into "maintenance_service_order_entity_confirmation" (
       "id", "service_order_id", "entity_id", "confirmed_at", "evidence_reference",
       "registered_by_user_id", "correlation_id"
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      ids.serviceOrder,
      ids.entity,
      new Date("2026-11-13T14:00:00.000Z"),
      `SEI-GLOSA-ROUTE-${suffix}`,
      ids.user,
      `corr-maintenance-confirmation-glosa-route-${suffix}`
    ]
  );

  return {
    suffix,
    serviceOrderId: ids.serviceOrder,
    serviceOrderServiceId: ids.serviceOrderService,
    contractItemId: ids.contractItem,
    authorizedUserId: ids.user
  };
}
