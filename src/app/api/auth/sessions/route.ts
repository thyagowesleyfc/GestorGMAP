import { ResolveAuthenticatedSession } from "../../../../modules/organization/application/resolve-authenticated-session";
import { handleSessionsRequest } from "../../../../modules/organization/api/sessions-route";
import { PrismaAuthenticatedUserContextReader } from "../../../../modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../shared/observability/api";
import { prisma } from "../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const sessions = new PrismaSessionStore(prisma);
const resolveSession = new ResolveAuthenticatedSession(
  sessions,
  new PrismaAuthenticatedUserContextReader(prisma)
);

export function GET(request: Request) {
  return withApiObservability(request, "/api/auth/sessions", ({ request: observedRequest }) =>
    handleSessionsRequest(observedRequest, {
      resolveSession,
      sessions
    })
  );
}
