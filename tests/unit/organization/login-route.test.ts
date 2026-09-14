import { describe, expect, it, vi } from "vitest";

import type { AuthenticateUserResult } from "../../../src/modules/organization/application/authenticate-user";
import type { LoginRateLimiter } from "../../../src/modules/organization/application/login-rate-limit";
import { handleLoginRequest } from "../../../src/modules/organization/api/login-route";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/login", {
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
            resetAt: new Date("2026-09-14T12:15:00.000Z")
          }
        : {
            allowed: false,
            retryAfterSeconds: 60,
            resetAt: new Date("2026-09-14T12:15:00.000Z")
          }
    ),
    reset: vi.fn()
  };
}

function makeDependencies(result: AuthenticateUserResult, rateLimiter = makeRateLimiter()) {
  return {
    authenticateUser: {
      execute: vi.fn().mockResolvedValue(result)
    },
    environment: "test" as const,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    rateLimiter
  };
}

describe("handleLoginRequest", () => {
  it("authenticates the user, sets the session cookie and does not expose the token", async () => {
    const dependencies = makeDependencies({
      ok: true,
      userId: "user-1",
      sessionId: "session-1",
      sessionToken: "raw-session-token",
      expiresAt: new Date("2026-09-14T20:00:00.000Z")
    });

    const response = await handleLoginRequest(
      request(
        {
          loginIdentifier: "usuario.gmap",
          password: "SenhaForte123"
        },
        {
          "user-agent": "Vitest",
          "x-forwarded-for": "203.0.113.10, 10.0.0.1"
        }
      ),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      expires_at: "2026-09-14T20:00:00.000Z"
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("gmap_session=raw-session-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    expect(dependencies.authenticateUser.execute).toHaveBeenCalledWith({
      loginIdentifier: "usuario.gmap",
      password: "SenhaForte123",
      userAgent: "Vitest",
      ipAddress: "203.0.113.10",
      now: new Date("2026-09-14T12:00:00.000Z")
    });
    expect(dependencies.rateLimiter.reset).toHaveBeenCalledWith({
      loginIdentifier: "usuario.gmap",
      ipAddress: "203.0.113.10"
    });
  });

  it("rejects invalid payloads before rate limit and authentication", async () => {
    const dependencies = makeDependencies({ ok: false, reason: "INVALID_CREDENTIALS" });

    const response = await handleLoginRequest(
      request({ loginIdentifier: " ", password: "SenhaForte123" }),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Informe identificador de login e senha."
    });
    expect(response.status).toBe(400);
    expect(dependencies.rateLimiter.consume).not.toHaveBeenCalled();
    expect(dependencies.authenticateUser.execute).not.toHaveBeenCalled();
  });

  it("returns the same unauthorized response for invalid credentials and inactive users", async () => {
    for (const reason of ["INVALID_CREDENTIALS", "USER_INACTIVE"] as const) {
      const dependencies = makeDependencies({ ok: false, reason });

      const response = await handleLoginRequest(
        request({ loginIdentifier: "usuario.gmap", password: "SenhaForte123" }),
        dependencies
      );

      await expect(response.json()).resolves.toEqual({
        error: "Credenciais invalidas."
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(dependencies.rateLimiter.reset).not.toHaveBeenCalled();
    }
  });

  it("returns 429 before authentication when the rate limiter blocks the identity", async () => {
    const rateLimiter = makeRateLimiter(false);
    const dependencies = makeDependencies(
      { ok: false, reason: "INVALID_CREDENTIALS" },
      rateLimiter
    );

    const response = await handleLoginRequest(
      request({ loginIdentifier: "usuario.gmap", password: "SenhaForte123" }),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Muitas tentativas de login. Tente novamente mais tarde."
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(dependencies.authenticateUser.execute).not.toHaveBeenCalled();
  });
});
