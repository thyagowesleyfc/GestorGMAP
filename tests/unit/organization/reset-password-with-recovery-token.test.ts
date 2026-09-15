import { describe, expect, it, vi } from "vitest";

import {
  ResetPasswordWithRecoveryToken,
  type PasswordRecoveryResetStore,
  type RecoveryPasswordHasher,
  type RecoveryTokenHasher
} from "../../../src/modules/organization/application/reset-password-with-recovery-token";

function makeDependencies(resetApplied = true) {
  const resets: PasswordRecoveryResetStore = {
    resetPassword: vi.fn().mockResolvedValue(resetApplied)
  };
  const passwordHasher: RecoveryPasswordHasher = {
    hash: vi.fn().mockResolvedValue("scrypt:new-password-hash")
  };
  const tokenHasher: RecoveryTokenHasher = {
    hash: vi.fn().mockReturnValue("sha256:recovery-token-hash")
  };

  return {
    resets,
    passwordHasher,
    tokenHasher
  };
}

describe("ResetPasswordWithRecoveryToken", () => {
  it("hashes the token and password before applying a reset", async () => {
    const dependencies = makeDependencies();
    const now = new Date("2026-09-15T11:00:00.000Z");
    const resetPassword = new ResetPasswordWithRecoveryToken(
      dependencies.resets,
      dependencies.passwordHasher,
      dependencies.tokenHasher
    );

    await expect(
      resetPassword.execute({ token: "raw-recovery-token", newPassword: "NovaSenha123", now })
    ).resolves.toEqual({ ok: true });

    expect(dependencies.tokenHasher.hash).toHaveBeenCalledWith("raw-recovery-token");
    expect(dependencies.passwordHasher.hash).toHaveBeenCalledWith("NovaSenha123");
    expect(dependencies.resets.resetPassword).toHaveBeenCalledWith({
      recoveryTokenHash: "sha256:recovery-token-hash",
      passwordHash: "scrypt:new-password-hash",
      now
    });
  });

  it("returns a neutral failure when the reset cannot be applied", async () => {
    const dependencies = makeDependencies(false);
    const resetPassword = new ResetPasswordWithRecoveryToken(
      dependencies.resets,
      dependencies.passwordHasher,
      dependencies.tokenHasher
    );

    await expect(
      resetPassword.execute({
        token: "raw-recovery-token",
        newPassword: "NovaSenha123",
        now: new Date("2026-09-15T11:00:00.000Z")
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_OR_EXPIRED_TOKEN" });
  });

  it("returns a neutral failure when the password policy rejects the new password", async () => {
    const dependencies = makeDependencies();
    vi.mocked(dependencies.passwordHasher.hash).mockRejectedValue(new Error("Weak password"));
    const resetPassword = new ResetPasswordWithRecoveryToken(
      dependencies.resets,
      dependencies.passwordHasher,
      dependencies.tokenHasher
    );

    await expect(
      resetPassword.execute({
        token: "raw-recovery-token",
        newPassword: "fraca",
        now: new Date("2026-09-15T11:00:00.000Z")
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_OR_EXPIRED_TOKEN" });
    expect(dependencies.resets.resetPassword).not.toHaveBeenCalled();
  });
});
