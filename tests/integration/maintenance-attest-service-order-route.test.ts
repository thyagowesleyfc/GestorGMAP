import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AttestMaintenanceServiceOrder } from "../../src/modules/maintenance/application/attest-maintenance-service-order";
import { handleAttestMaintenanceServiceOrderRequest } from "../../src/modules/maintenance/api/attest-maintenance-service-order-route";
import { PostgresMaintenanceServiceOrderAttester } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-attester";
import { ResolveAuthenticatedSession } from "../../src/modules/organization/application/resolve-authenticated-session";
import { PrismaAuthenticatedUserContextReader } from "../../src/modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../src/modules/organization/infrastructure/session/prisma-session-store";
import { hashSessionToken } from "../../src/modules/organization/infrastructure/session/session-token";
import { withApiObservability } from "../../src/shared/observability/api";

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

describe("rota HTTP de ateste da Ordem de Serviço", () => {
  it("autentica por sessão, persiste o ateste e faz replay HTTP idempotente", async () => {
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
      const sessionToken = `session-attest-route-${seed.suffix}`;
      await insertSession(client, seed.authorizedUserId, sessionToken);

      const resolveSession = new ResolveAuthenticatedSession(
        new PrismaSessionStore(prisma),
        new PrismaAuthenticatedUserContextReader(prisma)
      );
      const attestServiceOrder = new AttestMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderAttester(pool)
      );
      const dependencies = { resolveSession, attestServiceOrder };
      const body = {
        commandId: `cmd-maintenance-attest-service-order-route-${seed.suffix}`,
        attestedAt: "2026-11-13T16:00:00.000Z"
      };
      const requestUrl = `http://localhost/api/maintenance/service-orders/${seed.serviceOrderId}/attestation`;
      const correlationId = `corr-maintenance-attest-service-order-route-${seed.suffix}`;
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
          "/api/maintenance/service-orders/{serviceOrderId}/attestation",
          ({ correlationId: requestCorrelationId, request }) =>
            handleAttestMaintenanceServiceOrderRequest(
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
        status: "ATESTADA"
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
      expect(serviceOrder.rows).toEqual([{ status: "ATESTADA" }]);

      const idempotency = await client.query<{
        status: string;
        result_json: { ok?: boolean; serviceOrderId?: string; status?: string };
      }>(
        `select "status"::text as "status", "result_json"
           from "command_idempotency"
          where "command_name" = $1
            and "idempotency_key" = $2`,
        [ATTEST_SERVICE_ORDER_ACTION, body.commandId]
      );
      expect(idempotency.rows).toHaveLength(1);
      expect(idempotency.rows[0]).toMatchObject({
        status: "SUCCEEDED",
        result_json: {
          ok: true,
          serviceOrderId: seed.serviceOrderId,
          status: "ATESTADA"
        }
      });

      const audit = await client.query<{
        count: number;
        actor_user_id: string | null;
        team_context: string | null;
        correlation_id: string;
        next_value: {
          status?: string;
          attestedByUserId?: string;
        };
      }>(
        `select count(*) over ()::int as "count", "actor_user_id", "team_context",
                "correlation_id", "next_value"
           from "audit_entry"
          where "action" = $1
            and "object_id" = $2`,
        [ATTEST_SERVICE_ORDER_ACTION, seed.serviceOrderId]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        count: 1,
        actor_user_id: seed.authorizedUserId,
        team_context: "Patrimônio",
        correlation_id: correlationId,
        next_value: {
          status: "ATESTADA",
          attestedByUserId: seed.authorizedUserId
        }
      });

      const outbox = await client.query<{
        count: number;
        event_type: string;
        aggregate_id: string;
        payload: {
          status?: string;
          attestedByUserId?: string;
        };
      }>(
        `select count(*) over ()::int as "count", "event_type", "aggregate_id", "payload"
           from "outbox_event"
          where "event_type" = $1
            and "aggregate_id" = $2`,
        [SERVICE_ORDER_ATTESTED_EVENT, seed.serviceOrderId]
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]).toMatchObject({
        count: 1,
        event_type: SERVICE_ORDER_ATTESTED_EVENT,
        aggregate_id: seed.serviceOrderId,
        payload: {
          status: "ATESTADA",
          attestedByUserId: seed.authorizedUserId
        }
      });
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
  authorizedUserId: string;
  entityId: string;
};

async function insertSession(client: Client, userId: string, token: string): Promise<void> {
  await client.query(
    `insert into "user_session" (
       "id", "user_id", "session_token_hash", "expires_at", "last_seen_at", "updated_at"
     ) values ($1, $2, $3, current_timestamp + interval '1 day', current_timestamp, current_timestamp)`,
    [randomUUID(), userId, hashSessionToken(token)]
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
    request: randomUUID(),
    serviceOrder: randomUUID()
  };
  const greCode = `GRE-ATTEST-ROUTE-${suffix}`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE de ateste HTTP', current_timestamp)`,
    [ids.gre, greCode]
  );
  await client.query(
    `insert into "entity" (
       "id", "code", "name", "entity_type", "gre_id", "updated_at"
     ) values ($1, $2, 'Entidade de ateste HTTP', 'ESCOLA', $3, current_timestamp)`,
    [ids.entity, `ENT-ATTEST-ROUTE-${suffix}`, ids.gre]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informatica de ateste HTTP', current_timestamp)`,
    [ids.materialClass, `CLS-ATTEST-ROUTE-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Equipamento de ateste HTTP', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [ids.material, `MAT-ATTEST-ROUTE-${suffix}`, ids.materialClass]
  );
  await client.query(
    `insert into "patrimony" (
       "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
     ) values ($1, $2, $3, 'EM_USO', current_timestamp)`,
    [ids.patrimony, ids.material, ids.entity]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Operador autorizado do ateste HTTP', current_timestamp)`,
    [ids.person]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values ($1, $2, $3, 'ACTIVE', false, current_timestamp)`,
    [ids.user, ids.person, `authorized.attest.route.${suffix.toLowerCase()}@gmap.test`]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [ids.team, "Patrimônio"]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "active", "updated_at"
     ) values ($1, $2, $3, 'MEMBRO', 'GLOBAL', true, current_timestamp)`,
    [randomUUID(), ids.user, ids.team]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de ateste HTTP', current_timestamp)`,
    [ids.supplier, `FORN-ATTEST-ROUTE-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de servico para ateste HTTP', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-ATTEST-ROUTE-${suffix}`, ids.supplier]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version",
       "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'Solicitacao de ateste HTTP', 'Descricao de teste', $3,
       $3, $4, 'Autorizacao para teste HTTP', 1, $5, current_timestamp)`,
    [
      ids.request,
      ids.entity,
      new Date("2026-11-13T12:00:00.000Z"),
      ids.user,
      `corr-maintenance-request-attest-route-${suffix}`
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
      `corr-maintenance-target-attest-route-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_service_order" (
       "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
       "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, 'EXECUTADA', $6, $7, $8, current_timestamp)`,
    [
      ids.serviceOrder,
      `OS-ATTEST-ROUTE-${suffix}`,
      ids.request,
      ids.contract,
      ids.entity,
      new Date("2026-11-13T13:00:00.000Z"),
      ids.user,
      `corr-maintenance-service-order-attest-route-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_service_order_patrimony" (
       "id", "service_order_id", "maintenance_request_id", "patrimony_id"
     ) values ($1, $2, $3, $4)`,
    [randomUUID(), ids.serviceOrder, ids.request, ids.patrimony]
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
      `SEI-ATTEST-ROUTE-${suffix}`,
      ids.user,
      `corr-maintenance-confirmation-attest-route-${suffix}`
    ]
  );

  return {
    suffix,
    serviceOrderId: ids.serviceOrder,
    authorizedUserId: ids.user,
    entityId: ids.entity
  };
}
