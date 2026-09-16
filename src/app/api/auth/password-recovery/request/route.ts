import { RequestPasswordRecovery } from "../../../../../modules/organization/application/request-password-recovery";
import { createIamSecurityAuditLogger } from "../../../../../modules/organization/api/iam-security-audit";
import { handlePasswordRecoveryRequest } from "../../../../../modules/organization/api/password-recovery-request-route";
import { PrismaPasswordRecoveryRequestStore } from "../../../../../modules/organization/infrastructure/authentication/prisma-password-recovery-request-store";
import { PrismaPasswordRecoveryUserReader } from "../../../../../modules/organization/infrastructure/authentication/prisma-password-recovery-user-reader";
import { InMemoryLoginRateLimiter } from "../../../../../modules/organization/infrastructure/security/in-memory-login-rate-limiter";
import { SecurePasswordRecoveryTokenIssuer } from "../../../../../modules/organization/infrastructure/security/password-recovery-token";
import { prisma } from "../../../../../shared/prisma/client";
import { withApiObservability } from "../../../../../shared/observability/api";

export const dynamic = "force-dynamic";

const rateLimiter = new InMemoryLoginRateLimiter();
const requestPasswordRecovery = new RequestPasswordRecovery(
  new PrismaPasswordRecoveryUserReader(prisma),
  new PrismaPasswordRecoveryRequestStore(prisma),
  new SecurePasswordRecoveryTokenIssuer()
);

export function POST(request: Request) {
  return withApiObservability(
    request,
    "/api/auth/password-recovery/request",
    ({ correlationId, request: observedRequest }) =>
      handlePasswordRecoveryRequest(observedRequest, {
        requestPasswordRecovery,
        audit: createIamSecurityAuditLogger(correlationId),
        rateLimiter
      })
  );
}
