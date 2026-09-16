import { ResetPasswordWithRecoveryToken } from "../../../../../modules/organization/application/reset-password-with-recovery-token";
import { createIamSecurityAuditLogger } from "../../../../../modules/organization/api/iam-security-audit";
import { handlePasswordRecoveryResetRequest } from "../../../../../modules/organization/api/password-recovery-reset-route";
import { PrismaPasswordRecoveryResetStore } from "../../../../../modules/organization/infrastructure/authentication/prisma-password-recovery-reset-store";
import { InMemoryLoginRateLimiter } from "../../../../../modules/organization/infrastructure/security/in-memory-login-rate-limiter";
import { SecurePasswordRecoveryTokenIssuer } from "../../../../../modules/organization/infrastructure/security/password-recovery-token";
import { ScryptPasswordHasher } from "../../../../../modules/organization/infrastructure/security/scrypt-password-hasher";
import { prisma } from "../../../../../shared/prisma/client";
import { withApiObservability } from "../../../../../shared/observability/api";

export const dynamic = "force-dynamic";

const rateLimiter = new InMemoryLoginRateLimiter();
const resetPasswordWithRecoveryToken = new ResetPasswordWithRecoveryToken(
  new PrismaPasswordRecoveryResetStore(prisma),
  new ScryptPasswordHasher(),
  new SecurePasswordRecoveryTokenIssuer()
);

export function POST(request: Request) {
  return withApiObservability(
    request,
    "/api/auth/password-recovery/reset",
    ({ correlationId, request: observedRequest }) =>
      handlePasswordRecoveryResetRequest(observedRequest, {
        resetPasswordWithRecoveryToken,
        audit: createIamSecurityAuditLogger(correlationId),
        rateLimiter
      })
  );
}
