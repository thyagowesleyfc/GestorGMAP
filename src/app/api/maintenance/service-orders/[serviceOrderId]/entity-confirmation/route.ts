import { Pool } from "pg";

import { ConfirmMaintenanceServiceOrder } from "../../../../../../modules/maintenance/application/confirm-maintenance-service-order";
import { handleConfirmMaintenanceServiceOrderRequest } from "../../../../../../modules/maintenance/api/confirm-maintenance-service-order-route";
import { PostgresMaintenanceServiceOrderConfirmer } from "../../../../../../modules/maintenance/infrastructure/postgres-maintenance-service-order-confirmer";
import { ResolveAuthenticatedSession } from "../../../../../../modules/organization/application/resolve-authenticated-session";
import { PrismaAuthenticatedUserContextReader } from "../../../../../../modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../../../shared/observability/api";
import { prisma } from "../../../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const confirmServiceOrder = new ConfirmMaintenanceServiceOrder(
  new PostgresMaintenanceServiceOrderConfirmer(pool)
);
const resolveSession = new ResolveAuthenticatedSession(
  new PrismaSessionStore(prisma),
  new PrismaAuthenticatedUserContextReader(prisma)
);

type RouteContext = {
  params: Promise<{
    serviceOrderId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;

  return withApiObservability(
    request,
    "/api/maintenance/service-orders/{serviceOrderId}/entity-confirmation",
    ({ correlationId, request: observedRequest }) =>
      handleConfirmMaintenanceServiceOrderRequest(
        observedRequest,
        {
          serviceOrderId: params.serviceOrderId,
          correlationId
        },
        {
          resolveSession,
          confirmServiceOrder
        }
      )
  );
}
