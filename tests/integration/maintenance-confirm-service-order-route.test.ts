import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { ConfirmMaintenanceServiceOrder } from "../../src/modules/maintenance/application/confirm-maintenance-service-order";
import { handleConfirmMaintenanceServiceOrderRequest } from "../../src/modules/maintenance/api/confirm-maintenance-service-order-route";
import { PostgresMaintenanceServiceOrderConfirmer } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-service-order-confirmer";
import { PrismaAuthenticatedUserContextReader } from "../../src/modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { ResolveAuthenticatedSession } from "../../src/modules/organization/application/resolve-authenticated-session";
import { PrismaSessionStore } from "../../src/modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../src/shared/observability/api";
import { hashSessionToken } from "../../src/modules/organization/infrastructure/session/session-token";

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

describe("rota HTTP de confirmaÃ§Ã£o funcional da Entidade na OS", () => {
  it("autentica por sessÃ£o, persiste a confirmaÃ§Ã£o e faz replay idempotente", async () => {
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
      const sessionToken = `session-confirm-route-${seed.suffix}`;
      await insertSession(client, seed.authorizedUserId, sessionToken);

      const resolveSession = new ResolveAuthenticatedSession(
        new PrismaSessionStore(prisma),
        new PrismaAuthenticatedUserContextReader(prisma)
      );
      const confirmServiceOrder = new ConfirmMaintenanceServiceOrder(
        new PostgresMaintenanceServiceOrderConfirmer(pool)
      );
      const dependencies = { resolveSession, confirmServiceOrder };
      const body = {
        commandId: `cmd-maintenance-confirm-service-order-route-${seed.suffix}`,
        evidenceReference: "termo-de-confirmacao-entidade-route-001",
        confirmedAt: "2026-11-13T16:00:00.000Z"
      };
      const requestUrl = `http://localhost/api/maintenance/service-orders/${seed.validServiceOrderId}/entity-confirmation`;
      const correlationId = `corr-maintenance-confirm-service-order-route-${seed.suffix}`;
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
          "/api/maintenance/service-orders/{serviceOrderId}/entity-confirmation",
          ({ correlationId: requestCorrelationId, request }) =>
            handleConfirmMaintenanceServiceOrderRequest(
              request,
              {
                serviceOrderId: seed.validServiceOrderId,
                correlationId: requestCorrelationId
              },
              dependencies
            )
        );

      const firstResponse = await post();
      const firstPayload = await firstResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(firstPayload).toMatchObject({
        ok: true,
        service_order_id: seed.validServiceOrderId,
        status: "EXECUTADA"
      });
      expect(firstResponse.headers.get("x-correlation-id")).toBe(
        `corr-maintenance-confirm-service-order-route-${seed.suffix}`
      );

      const secondResponse = await post();
      const secondPayload = await secondResponse.json();

      expect(secondResponse.status).toBe(200);
      expect(secondPayload).toEqual(firstPayload);

      const confirmation = await client.query<{
        id: string;
        service_order_id: string;
        entity_id: string;
        evidence_reference: string;
        registered_by_user_id: string;
        correlation_id: string;
      }>(
        `select "id", "service_order_id", "entity_id", "evidence_reference",
                  "registered_by_user_id", "correlation_id"
             from "maintenance_service_order_entity_confirmation"
            where "service_order_id" = $1`,
        [seed.validServiceOrderId]
      );
      expect(confirmation.rows).toHaveLength(1);
      expect(confirmation.rows[0]).toMatchObject({
        service_order_id: seed.validServiceOrderId,
        entity_id: seed.entityId,
        evidence_reference: body.evidenceReference,
        registered_by_user_id: seed.authorizedUserId,
        correlation_id: `corr-maintenance-confirm-service-order-route-${seed.suffix}`
      });
      expect(confirmation.rows[0]?.id).toBe(firstPayload.confirmation_id);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
             from "audit_entry"
            where "action" = $1
              and "next_value"->>'serviceOrderId' = $2`,
        [CONFIRM_SERVICE_ORDER_COMMAND, seed.validServiceOrderId]
      );
      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
             from "outbox_event"
            where "event_type" = $1
              and "aggregate_id" = $2`,
        [SERVICE_ORDER_ENTITY_CONFIRMED_EVENT, seed.validServiceOrderId]
      );
      expect(audit.rows[0]?.count).toBe(1);
      expect(outbox.rows[0]?.count).toBe(1);
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
  validServiceOrderId: string;
  authorizedUserId: string;
  entityId: string;
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
    person: randomUUID(),
    user: randomUUID(),
    team: randomUUID(),
    supplier: randomUUID(),
    contract: randomUUID(),
    request: randomUUID(),
    serviceOrder: randomUUID()
  };
  const greCode = `GRE-CONFIRM-ROUTE-${suffix}`;

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE de confirmaÃ§Ã£o HTTP', current_timestamp)`,
    [ids.gre, greCode]
  );
  await client.query(
    `insert into "entity" (
       "id", "code", "name", "entity_type", "gre_id", "updated_at"
     ) values ($1, $2, 'Entidade de confirmaÃ§Ã£o HTTP', 'ESCOLA', $3, current_timestamp)`,
    [ids.entity, `ENT-CONFIRM-ROUTE-${suffix}`, ids.gre]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Operador autorizado da rota', current_timestamp)`,
    [ids.person]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values ($1, $2, $3, 'ACTIVE', false, current_timestamp)`,
    [ids.user, ids.person, `authorized.route.${suffix.toLowerCase()}@gmap.test`]
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
     values ($1, $2, 'Prestador de confirmaÃ§Ã£o HTTP', current_timestamp)`,
    [ids.supplier, `FORN-CONFIRM-ROUTE-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values ($1, $2, $3, 'Contrato de serviÃ§o para confirmaÃ§Ã£o HTTP', '2026-01-01', '2026-12-31', true, current_timestamp)`,
    [ids.contract, `CTR-CONFIRM-ROUTE-${suffix}`, ids.supplier]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "authorized_at", "authorized_by_user_id", "authorization_reason", "version",
       "correlation_id", "updated_at"
     ) values ($1, $2, 'EM_ANALISE', 'SolicitaÃ§Ã£o de confirmaÃ§Ã£o HTTP', 'DescriÃ§Ã£o de teste', $3,
       $3, $4, 'AutorizaÃ§Ã£o para teste HTTP', 1, $5, current_timestamp)`,
    [
      ids.request,
      ids.entity,
      new Date("2026-11-13T12:00:00.000Z"),
      ids.user,
      `corr-maintenance-request-confirm-route-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_service_order" (
       "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
       "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
     ) values ($1, $2, $3, $4, $5, 'EXECUTADA', $6, $7, $8, current_timestamp)`,
    [
      ids.serviceOrder,
      `OS-CONFIRM-ROUTE-${suffix}`,
      ids.request,
      ids.contract,
      ids.entity,
      new Date("2026-11-13T13:00:00.000Z"),
      ids.user,
      `corr-maintenance-service-order-confirm-route-${suffix}`
    ]
  );

  return {
    suffix,
    validServiceOrderId: ids.serviceOrder,
    authorizedUserId: ids.user,
    entityId: ids.entity
  };
}
