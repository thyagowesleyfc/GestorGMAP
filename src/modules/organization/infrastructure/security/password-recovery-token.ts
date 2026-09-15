import { createHash, randomBytes } from "node:crypto";

import type { PasswordRecoveryTokenIssuer } from "../../application/request-password-recovery";

const PASSWORD_RECOVERY_TOKEN_BYTES = 32;
const PASSWORD_RECOVERY_TOKEN_HASH_ALGORITHM = "sha256";

export function generatePasswordRecoveryToken(): string {
  return randomBytes(PASSWORD_RECOVERY_TOKEN_BYTES).toString("base64url");
}

export function hashPasswordRecoveryToken(token: string): string {
  if (token.trim().length === 0) {
    throw new Error("Password recovery token must not be blank");
  }

  const digest = createHash(PASSWORD_RECOVERY_TOKEN_HASH_ALGORITHM)
    .update(token, "utf8")
    .digest("base64url");

  return `${PASSWORD_RECOVERY_TOKEN_HASH_ALGORITHM}:${digest}`;
}

export class SecurePasswordRecoveryTokenIssuer implements PasswordRecoveryTokenIssuer {
  generate(): string {
    return generatePasswordRecoveryToken();
  }

  hash(token: string): string {
    return hashPasswordRecoveryToken(token);
  }
}
