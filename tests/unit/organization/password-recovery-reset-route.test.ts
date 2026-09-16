import { describe, expect, it, vi } from "vitest";

import type { LoginRateLimiter } from "../../../src/modules/organization/application/login-rate-limit";
import type { IamSecurityAuditLogger } from "../../../src/modules/organization/api/iam-security-audit";
import { handlePasswordRecoveryResetRequest } from "../../../src/modules/organization/api/password-recovery-reset-route";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/password-recovery/reset", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...headers
    },
    method: "POST"
  });
}

function makeRateLimiter(allowed = true): LoginRateLimiter {
  return {
    consume: vi.fn().mockReturnValue(
      allowed
        ? {
            allowed: true,
            remainingAttempts: 4,
            resetAt: new Date("2026-09-15T11:15:00.000Z")
          }
        : {
            allowed: false,
            retryAfterSeconds: 60,
            resetAt: new Date("2026-09-15T11:15:00.000Z")
          }
    ),
    reset: vi.fn()
  };
}

function makeAuditLogger(): IamSecurityAuditLogger {
  return {
    log: vi.fn()
  };
}

function makeDependencies(options: { ok?: boolean; rateLimiter?: LoginRateLimiter } = {}) {
  return {
    resetPasswordWithRecoveryToken: {
      execute: vi
        .fn()
        .mockResolvedValue(
          (options.ok ?? true) ? { ok: true } : { ok: false, reason: "INVALID_OR_EXPIRED_TOKEN" }
        )
    },
    audit: makeAuditLogger(),
    now: () => new Date("2026-09-15T11:00:00.000Z"),
    rateLimiter: options.rateLimiter ?? makeRateLimiter()
  };
}

describe("handlePasswordRecoveryResetRequest", () => {
  it("resets a password with a recovery token without exposing secrets", async () => {
    const dependencies = makeDependencies();

    const response = await handlePasswordRecoveryResetRequest(
      request(
        { token: "raw-recovery-token", newPassword: "NovaSenha123" },
        {
          "x-forwarded-for": "203.0.113.10, 10.0.0.1"
        }
      ),
      dependencies
    );

    const payload = await response.json();

    expect(payload).toEqual({
      ok: true,
      message: "Senha atualizada com sucesso."
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(payload)).not.toContain("token");
    expect(JSON.stringify(payload)).not.toContain("senha");
    expect(dependencies.rateLimiter.consume).toHaveBeenCalledWith(
      {
        ipAddress: "203.0.113.10"
      },
      new Date("2026-09-15T11:00:00.000Z")
    );
    expect(dependencies.resetPasswordWithRecoveryToken.execute).toHaveBeenCalledWith({
      token: "raw-recovery-token",
      newPassword: "NovaSenha123",
      now: new Date("2026-09-15T11:00:00.000Z")
    });
    expect(dependencies.audit.log).toHaveBeenCalledWith("iam.password_recovery.reset_succeeded", {
      ip_address: "203.0.113.10"
    });
    expect(JSON.stringify(vi.mocked(dependencies.audit.log).mock.calls)).not.toContain(
      "raw-recovery-token"
    );
    expect(JSON.stringify(vi.mocked(dependencies.audit.log).mock.calls)).not.toContain(
      "NovaSenha123"
    );
  });

  it("returns the same neutral message for invalid payloads and invalid tokens", async () => {
    for (const scenario of [
      { body: { token: " ", newPassword: "NovaSenha123" }, dependencies: makeDependencies() },
      {
        body: { token: "raw-recovery-token", newPassword: "NovaSenha123" },
        dependencies: makeDependencies({ ok: false })
      }
    ]) {
      const response = await handlePasswordRecoveryResetRequest(
        request(scenario.body),
        scenario.dependencies
      );

      await expect(response.json()).resolves.toEqual({
        error: "N\u00e3o foi poss\u00edvel atualizar a senha com os dados informados."
      });
      expect(response.status).toBe(400);
      expect(scenario.dependencies.audit.log).toHaveBeenCalled();
    }
  });

  it("uses a non-secret fallback identity when the client IP is unavailable", async () => {
    const dependencies = makeDependencies();

    await handlePasswordRecoveryResetRequest(
      request({ token: "raw-recovery-token", newPassword: "NovaSenha123" }),
      dependencies
    );

    expect(dependencies.rateLimiter.consume).toHaveBeenCalledWith(
      {
        ipAddress: "unknown"
      },
      new Date("2026-09-15T11:00:00.000Z")
    );
  });

  it("returns 429 before reset when rate limited", async () => {
    const rateLimiter = makeRateLimiter(false);
    const dependencies = makeDependencies({ rateLimiter });

    const response = await handlePasswordRecoveryResetRequest(
      request({ token: "raw-recovery-token", newPassword: "NovaSenha123" }),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Muitas tentativas de recupera\u00e7\u00e3o. Tente novamente mais tarde."
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(dependencies.resetPasswordWithRecoveryToken.execute).not.toHaveBeenCalled();
    expect(dependencies.audit.log).toHaveBeenCalledWith(
      "iam.password_recovery.reset_rate_limited",
      {
        ip_address: "unknown",
        reason_code: "rate_limited"
      }
    );
  });
});
