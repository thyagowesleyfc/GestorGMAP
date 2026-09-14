import { AuthenticateUser } from "../../../../modules/organization/application/authenticate-user";
import { handleLoginRequest } from "../../../../modules/organization/api/login-route";
import { PrismaAuthenticationCredentialReader } from "../../../../modules/organization/infrastructure/authentication/prisma-authentication-credential-reader";
import { ScryptPasswordHasher } from "../../../../modules/organization/infrastructure/security/scrypt-password-hasher";
import { InMemoryLoginRateLimiter } from "../../../../modules/organization/infrastructure/security/in-memory-login-rate-limiter";
import { PrismaSessionStore } from "../../../../modules/organization/infrastructure/session/prisma-session-store";
import { prisma } from "../../../../shared/prisma/client";
import { withApiObservability } from "../../../../shared/observability/api";

export const dynamic = "force-dynamic";

const rateLimiter = new InMemoryLoginRateLimiter();
const authenticateUser = new AuthenticateUser(
  new PrismaAuthenticationCredentialReader(prisma),
  new ScryptPasswordHasher(),
  new PrismaSessionStore(prisma)
);

export function POST(request: Request) {
  return withApiObservability(request, "/api/auth/login", ({ request: observedRequest }) =>
    handleLoginRequest(observedRequest, {
      authenticateUser,
      rateLimiter
    })
  );
}
