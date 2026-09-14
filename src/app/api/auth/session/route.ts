import { ResolveAuthenticatedSession } from "../../../../modules/organization/application/resolve-authenticated-session";
import { handleSessionRequest } from "../../../../modules/organization/api/session-route";
import { PrismaAuthenticatedUserContextReader } from "../../../../modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../shared/observability/api";
import { prisma } from "../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const resolveSession = new ResolveAuthenticatedSession(
  new PrismaSessionStore(prisma),
  new PrismaAuthenticatedUserContextReader(prisma)
);

export function GET(request: Request) {
  return withApiObservability(request, "/api/auth/session", ({ request: observedRequest }) =>
    handleSessionRequest(observedRequest, {
      resolveSession
    })
  );
}
