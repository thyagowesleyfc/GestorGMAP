import { handleLogoutRequest } from "../../../../modules/organization/api/logout-route";
import { PrismaSessionStore } from "../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../shared/observability/api";
import { prisma } from "../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const sessions = new PrismaSessionStore(prisma);

export function POST(request: Request) {
  return withApiObservability(request, "/api/auth/logout", ({ request: observedRequest }) =>
    handleLogoutRequest(observedRequest, {
      sessions
    })
  );
}
