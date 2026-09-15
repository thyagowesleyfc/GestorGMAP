import { describe, expect, it } from "vitest";

import {
  generatePasswordRecoveryToken,
  hashPasswordRecoveryToken
} from "../../../src/modules/organization/infrastructure/security/password-recovery-token";

describe("password recovery token", () => {
  it("generates opaque tokens and stores only deterministic hashes", () => {
    const token = generatePasswordRecoveryToken();
    const hash = hashPasswordRecoveryToken(token);

    expect(token).not.toHaveLength(0);
    expect(hash).toMatch(/^sha256:/);
    expect(hash).toBe(hashPasswordRecoveryToken(token));
    expect(hash).not.toContain(token);
  });

  it("rejects blank tokens before hashing", () => {
    expect(() => hashPasswordRecoveryToken("  ")).toThrow(
      "Password recovery token must not be blank"
    );
  });
});
