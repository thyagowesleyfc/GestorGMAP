import { createHash, randomBytes } from "node:crypto";

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_HASH_ALGORITHM = "sha256";

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  if (token.trim().length === 0) {
    throw new Error("Session token must not be blank");
  }

  const digest = createHash(SESSION_TOKEN_HASH_ALGORITHM).update(token, "utf8").digest("base64url");

  return `${SESSION_TOKEN_HASH_ALGORITHM}:${digest}`;
}
