import { describe, expect, it, vi } from "vitest";

import type { IamSecurityAuditLogger } from "../../../src/modules/organization/api/iam-security-audit";
import { handleRevokeSessionRequest } from "../../../src/modules/organization/api/revoke-session-route";

function request(cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/sessions/session-2", {
    headers: cookie === undefined ? headers : { cookie, ...headers },
    method: "DELETE"
  });
}

const resolvedSession = {
  session: {
    id: "session-1",
    userId: "user-1",
    expiresAt: new Date("2026-09-14T20:00:00.000Z")
  },
  user: {
    id: "user-1",
    personId: "person-1",
    status: "ACTIVE" as const,
    isTechnicalSuperuser: false
  },
  memberships: []
};

function makeAuditLogger(): IamSecurityAuditLogger {
  return {
    log: vi.fn()
  };
}

function makeDependencies(
  options: {
    resolved?: typeof resolvedSession | null;
    revokedCount?: number;
  } = {}
) {
  return {
    audit: makeAuditLogger(),
    environment: "test" as const,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    resolveSession: {
      execute: vi
        .fn()
        .mockResolvedValue(options.resolved === undefined ? resolvedSession : options.resolved)
    },
    sessions: {
      revokeActiveForUser: vi.fn().mockResolvedValue(options.revokedCount ?? 1)
    }
  };
}

describe("handleRevokeSessionRequest", () => {
  it("revokes an active session that belongs to the authenticated user", async () => {
    const dependencies = makeDependencies();

    const response = await handleRevokeSessionRequest(
      request("gmap_session=raw-session-token"),
      { sessionId: "session-2" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(dependencies.resolveSession.execute).toHaveBeenCalledWith({
      sessionToken: "raw-session-token",
      now: new Date("2026-09-14T12:00:00.000Z")
    });
    expect(dependencies.sessions.revokeActiveForUser).toHaveBeenCalledWith(
      "session-2",
      "user-1",
      new Date("2026-09-14T12:00:00.000Z")
    );
    expect(dependencies.audit.log).toHaveBeenCalledWith("iam.session.revoked", {
      current_session_revoked: false,
      ip_address: null,
      target_session_id: "session-2",
      user_id: "user-1"
    });
    expect(JSON.stringify(vi.mocked(dependencies.audit.log).mock.calls)).not.toContain(
      "raw-session-token"
    );
  });

  it("expires the cookie when revoking the current session", async () => {
    const dependencies = makeDependencies();

    const response = await handleRevokeSessionRequest(
      request("gmap_session=raw-session-token"),
      { sessionId: "session-1" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("gmap_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("returns 404 without leaking whether the target session exists for another user", async () => {
    const dependencies = makeDependencies({ revokedCount: 0 });

    const response = await handleRevokeSessionRequest(
      request("gmap_session=raw-session-token"),
      { sessionId: "other-session" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao encontrada."
    });
    expect(response.status).toBe(404);
  });

  it("blocks cross-origin session revocation before resolving the session", async () => {
    const dependencies = makeDependencies();

    const response = await handleRevokeSessionRequest(
      request("gmap_session=raw-session-token", { origin: "https://evil.example" }),
      { sessionId: "session-2" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Origem da requisi\u00e7\u00e3o n\u00e3o permitida."
    });
    expect(response.status).toBe(403);
    expect(dependencies.resolveSession.execute).not.toHaveBeenCalled();
    expect(dependencies.sessions.revokeActiveForUser).not.toHaveBeenCalled();
  });
  it("returns 401 and expires the cookie when the cookie is missing", async () => {
    const dependencies = makeDependencies();

    const response = await handleRevokeSessionRequest(
      request(),
      { sessionId: "session-2" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.sessions.revokeActiveForUser).not.toHaveBeenCalled();
  });

  it("returns 401 and expires the cookie when the current session cannot be resolved", async () => {
    const dependencies = makeDependencies({ resolved: null });

    const response = await handleRevokeSessionRequest(
      request("gmap_session=stale-token"),
      { sessionId: "session-2" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.sessions.revokeActiveForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for a blank target session id", async () => {
    const dependencies = makeDependencies();

    const response = await handleRevokeSessionRequest(
      request("gmap_session=raw-session-token"),
      { sessionId: " " },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao encontrada."
    });
    expect(response.status).toBe(404);
    expect(dependencies.resolveSession.execute).not.toHaveBeenCalled();
    expect(dependencies.sessions.revokeActiveForUser).not.toHaveBeenCalled();
  });
});
