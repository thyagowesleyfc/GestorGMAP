import { Pool } from "pg";

import { GlosaMaintenanceServiceOrder } from "../../../../../../modules/maintenance/application/glosa-maintenance-service-order";
import { handleGlosaMaintenanceServiceOrderRequest } from "../../../../../../modules/maintenance/api/glosa-maintenance-service-order-route";
import { PostgresMaintenanceServiceOrderGlosser } from "../../../../../../modules/maintenance/infrastructure/postgres-maintenance-service-order-glosser";
import { ResolveAuthenticatedSession } from "../../../../../../modules/organization/application/resolve-authenticated-session";
import { PrismaAuthenticatedUserContextReader } from "../../../../../../modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../../../shared/observability/api";
import { prisma } from "../../../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const glosaServiceOrder = new GlosaMaintenanceServiceOrder(
  new PostgresMaintenanceServiceOrderGlosser(pool)
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
    "/api/maintenance/service-orders/{serviceOrderId}/glosa",
    ({ correlationId, request: observedRequest }) =>
      handleGlosaMaintenanceServiceOrderRequest(
        observedRequest,
        {
          serviceOrderId: params.serviceOrderId,
          correlationId
        },
        {
          resolveSession,
          glosaServiceOrder
        }
      )
  );
}
