import { ResolveAuthenticatedSession } from "../../../../../modules/organization/application/resolve-authenticated-session";
import { createIamSecurityAuditLogger } from "../../../../../modules/organization/api/iam-security-audit";
import { handleRevokeSessionRequest } from "../../../../../modules/organization/api/revoke-session-route";
import { PrismaAuthenticatedUserContextReader } from "../../../../../modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";
import { PrismaSessionStore } from "../../../../../modules/organization/infrastructure/session/prisma-session-store";
import { withApiObservability } from "../../../../../shared/observability/api";
import { prisma } from "../../../../../shared/prisma/client";

export const dynamic = "force-dynamic";

const sessions = new PrismaSessionStore(prisma);
const resolveSession = new ResolveAuthenticatedSession(
  sessions,
  new PrismaAuthenticatedUserContextReader(prisma)
);

type RouteContext = {
  params: Promise<{
    sessionId: string;
  }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const params = await context.params;

  return withApiObservability(
    request,
    "/api/auth/sessions/{sessionId}",
    ({ correlationId, request: observedRequest }) =>
      handleRevokeSessionRequest(
        observedRequest,
        {
          sessionId: params.sessionId
        },
        {
          resolveSession,
          audit: createIamSecurityAuditLogger(correlationId),
          sessions
        }
      )
  );
}
