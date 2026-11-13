import { Pool } from "pg";

import { AttestMaintenanceServiceOrder } from "../../../../../../modules/maintenance/application/attest-maintenance-service-order";
import { handleAttestMaintenanceServiceOrderRequest } from "../../../../../../modules/maintenance/api/attest-maintenance-service-order-route";
import { PostgresMaintenanceServiceOrderAttester } from "../../../../../../modules/maintenance/infrastructure/postgres-maintenance-service-order-attester";
import { ResolveAuthenticatedSession } from "../../../../../../modules/organization/application/resolve-authenticated-session";
import { PrismaAuthenticatedUserContextReader } from "../../../../../../modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../../../shared/observability/api";
import { prisma } from "../../../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const attestServiceOrder = new AttestMaintenanceServiceOrder(
  new PostgresMaintenanceServiceOrderAttester(pool)
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
    "/api/maintenance/service-orders/{serviceOrderId}/attestation",
    ({ correlationId, request: observedRequest }) =>
      handleAttestMaintenanceServiceOrderRequest(
        observedRequest,
        {
          serviceOrderId: params.serviceOrderId,
          correlationId
        },
        {
          resolveSession,
          attestServiceOrder
        }
      )
  );
}
