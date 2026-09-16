import { describe, expect, it, vi } from "vitest";

import type { LoginRateLimiter } from "../../../src/modules/organization/application/login-rate-limit";
import type { IamSecurityAuditLogger } from "../../../src/modules/organization/api/iam-security-audit";
import { handlePasswordRecoveryRequest } from "../../../src/modules/organization/api/password-recovery-request-route";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/password-recovery/request", {
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
            resetAt: new Date("2026-09-15T10:15:00.000Z")
          }
        : {
            allowed: false,
            retryAfterSeconds: 60,
            resetAt: new Date("2026-09-15T10:15:00.000Z")
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

function makeDependencies(rateLimiter = makeRateLimiter()) {
  return {
    requestPasswordRecovery: {
      execute: vi.fn().mockResolvedValue({ ok: true })
    },
    audit: makeAuditLogger(),
    now: () => new Date("2026-09-15T10:00:00.000Z"),
    rateLimiter
  };
}

describe("handlePasswordRecoveryRequest", () => {
  it("accepts the request with a neutral response and no token exposure", async () => {
    const dependencies = makeDependencies();

    const response = await handlePasswordRecoveryRequest(
      request(
        { loginIdentifier: "usuario.gmap" },
        {
          "x-forwarded-for": "203.0.113.10, 10.0.0.1"
        }
      ),
      dependencies
    );

    const payload = await response.json();

    expect(payload).toEqual({
      ok: true,
      message:
        "Se houver uma conta ativa para este identificador, a solicita\u00e7\u00e3o de recupera\u00e7\u00e3o ser\u00e1 registrada."
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(payload)).not.toContain("token");
    expect(dependencies.rateLimiter.consume).toHaveBeenCalledWith(
      {
        loginIdentifier: "usuario.gmap",
        ipAddress: "203.0.113.10"
      },
      new Date("2026-09-15T10:00:00.000Z")
    );
    expect(dependencies.requestPasswordRecovery.execute).toHaveBeenCalledWith({
      loginIdentifier: "usuario.gmap",
      now: new Date("2026-09-15T10:00:00.000Z")
    });
    expect(dependencies.audit.log).toHaveBeenCalledWith("iam.password_recovery.request_accepted", {
      ip_address: "203.0.113.10"
    });
    expect(JSON.stringify(vi.mocked(dependencies.audit.log).mock.calls)).not.toContain(
      "usuario.gmap"
    );
  });

  it("rejects invalid payloads before rate limit and application service", async () => {
    const dependencies = makeDependencies();

    const response = await handlePasswordRecoveryRequest(
      request({ loginIdentifier: " " }),
      dependencies
    );

    const payload = await response.json();

    expect(payload).toEqual({
      error: "Informe o identificador de login."
    });
    expect(response.status).toBe(400);
    expect(dependencies.rateLimiter.consume).not.toHaveBeenCalled();
    expect(dependencies.requestPasswordRecovery.execute).not.toHaveBeenCalled();
    expect(dependencies.audit.log).toHaveBeenCalledWith("iam.password_recovery.request_rejected", {
      reason_code: "invalid_payload"
    });
  });

  it("returns 429 before creating a recovery request when rate limited", async () => {
    const rateLimiter = makeRateLimiter(false);
    const dependencies = makeDependencies(rateLimiter);

    const response = await handlePasswordRecoveryRequest(
      request({ loginIdentifier: "usuario.gmap" }),
      dependencies
    );

    const payload = await response.json();

    expect(payload).toEqual({
      error: "Muitas solicita\u00e7\u00f5es de recupera\u00e7\u00e3o. Tente novamente mais tarde."
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(dependencies.requestPasswordRecovery.execute).not.toHaveBeenCalled();
    expect(dependencies.audit.log).toHaveBeenCalledWith(
      "iam.password_recovery.request_rate_limited",
      {
        ip_address: null,
        reason_code: "rate_limited"
      }
    );
  });
});
