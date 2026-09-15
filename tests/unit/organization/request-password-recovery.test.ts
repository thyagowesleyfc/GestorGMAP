import { describe, expect, it, vi } from "vitest";

import {
  RequestPasswordRecovery,
  type PasswordRecoveryRequestStore,
  type PasswordRecoveryTokenIssuer,
  type PasswordRecoveryUser,
  type PasswordRecoveryUserReader
} from "../../../src/modules/organization/application/request-password-recovery";

function user(overrides: Partial<PasswordRecoveryUser> = {}): PasswordRecoveryUser {
  return {
    id: "user-1",
    status: "ACTIVE",
    ...overrides
  };
}

function makeDependencies(foundUser: PasswordRecoveryUser | null = user()) {
  const users: PasswordRecoveryUserReader = {
    findByLoginIdentifier: vi.fn().mockResolvedValue(foundUser)
  };
  const requests: PasswordRecoveryRequestStore = {
    create: vi.fn().mockResolvedValue(undefined)
  };
  const tokens: PasswordRecoveryTokenIssuer = {
    generate: vi.fn().mockReturnValue("raw-recovery-token"),
    hash: vi.fn().mockReturnValue("sha256:recovery-token-hash")
  };

  return {
    users,
    requests,
    tokens
  };
}

describe("RequestPasswordRecovery", () => {
  it("creates a hashed recovery token for an active user", async () => {
    const dependencies = makeDependencies();
    const now = new Date("2026-09-15T10:00:00.000Z");
    const requestPasswordRecovery = new RequestPasswordRecovery(
      dependencies.users,
      dependencies.requests,
      dependencies.tokens
    );

    await expect(
      requestPasswordRecovery.execute({ loginIdentifier: "  Usuario.GMAP  ", now })
    ).resolves.toEqual({ ok: true });

    expect(dependencies.users.findByLoginIdentifier).toHaveBeenCalledWith("usuario.gmap");
    expect(dependencies.tokens.generate).toHaveBeenCalledOnce();
    expect(dependencies.tokens.hash).toHaveBeenCalledWith("raw-recovery-token");
    expect(dependencies.requests.create).toHaveBeenCalledWith({
      userId: "user-1",
      recoveryTokenHash: "sha256:recovery-token-hash",
      expiresAt: new Date("2026-09-15T10:15:00.000Z"),
      now
    });
  });

  it("returns the same successful result for unknown and inactive users", async () => {
    for (const foundUser of [null, user({ status: "INACTIVE" })]) {
      const dependencies = makeDependencies(foundUser);
      const requestPasswordRecovery = new RequestPasswordRecovery(
        dependencies.users,
        dependencies.requests,
        dependencies.tokens
      );

      await expect(
        requestPasswordRecovery.execute({
          loginIdentifier: "usuario.gmap",
          now: new Date("2026-09-15T10:00:00.000Z")
        })
      ).resolves.toEqual({ ok: true });

      expect(dependencies.tokens.generate).not.toHaveBeenCalled();
      expect(dependencies.requests.create).not.toHaveBeenCalled();
    }
  });

  it("validates the recovery token TTL", () => {
    const dependencies = makeDependencies();

    expect(
      () =>
        new RequestPasswordRecovery(
          dependencies.users,
          dependencies.requests,
          dependencies.tokens,
          {
            tokenTtlMs: 500
          }
        )
    ).toThrow("Password recovery token TTL must be at least one second.");
  });
});
