import { describe, expect, it, vi } from "vitest";

import { handleSessionsRequest } from "../../../src/modules/organization/api/sessions-route";

function request(cookie?: string): Request {
  return new Request("http://localhost/api/auth/sessions", {
    headers: cookie === undefined ? undefined : { cookie },
    method: "GET"
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

function sessionRecord(
  overrides: Partial<{
    id: string;
    userAgent: string | null;
    ipAddress: string | null;
    expiresAt: Date;
    lastSeenAt: Date;
    createdAt: Date;
  }> = {}
) {
  const now = new Date("2026-09-14T12:00:00.000Z");

  return {
    id: overrides.id ?? "session-1",
    userId: "user-1",
    userAgent: Object.hasOwn(overrides, "userAgent") ? overrides.userAgent! : "Vitest",
    ipAddress: Object.hasOwn(overrides, "ipAddress") ? overrides.ipAddress! : "203.0.113.10",
    expiresAt: overrides.expiresAt ?? new Date("2026-09-14T20:00:00.000Z"),
    revokedAt: null,
    lastSeenAt: overrides.lastSeenAt ?? now,
    createdAt: overrides.createdAt ?? new Date("2026-09-14T11:00:00.000Z"),
    updatedAt: now
  };
}

function makeDependencies(
  options: {
    resolved?: typeof resolvedSession | null;
    sessions?: ReturnType<typeof sessionRecord>[];
  } = {}
) {
  return {
    environment: "test" as const,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    resolveSession: {
      execute: vi
        .fn()
        .mockResolvedValue(options.resolved === undefined ? resolvedSession : options.resolved)
    },
    sessions: {
      listActiveForUser: vi.fn().mockResolvedValue(
        options.sessions ?? [
          sessionRecord(),
          sessionRecord({
            id: "session-2",
            userAgent: null,
            ipAddress: null,
            lastSeenAt: new Date("2026-09-14T11:30:00.000Z"),
            createdAt: new Date("2026-09-14T10:00:00.000Z")
          })
        ]
      )
    }
  };
}

describe("handleSessionsRequest", () => {
  it("lists active sessions for the authenticated user and marks the current session", async () => {
    const dependencies = makeDependencies();

    const response = await handleSessionsRequest(
      request("gmap_session=raw-session-token"),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          id: "session-1",
          current: true,
          user_agent: "Vitest",
          ip_address: "203.0.113.10",
          expires_at: "2026-09-14T20:00:00.000Z",
          last_seen_at: "2026-09-14T12:00:00.000Z",
          created_at: "2026-09-14T11:00:00.000Z"
        },
        {
          id: "session-2",
          current: false,
          user_agent: null,
          ip_address: null,
          expires_at: "2026-09-14T20:00:00.000Z",
          last_seen_at: "2026-09-14T11:30:00.000Z",
          created_at: "2026-09-14T10:00:00.000Z"
        }
      ]
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(dependencies.resolveSession.execute).toHaveBeenCalledWith({
      sessionToken: "raw-session-token",
      now: new Date("2026-09-14T12:00:00.000Z")
    });
    expect(dependencies.sessions.listActiveForUser).toHaveBeenCalledWith(
      "user-1",
      new Date("2026-09-14T12:00:00.000Z")
    );
  });

  it("returns 401 and expires the cookie when the cookie is missing", async () => {
    const dependencies = makeDependencies();

    const response = await handleSessionsRequest(request(), dependencies);

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.resolveSession.execute).not.toHaveBeenCalled();
    expect(dependencies.sessions.listActiveForUser).not.toHaveBeenCalled();
  });

  it("returns 401 and expires the cookie when the session cannot be resolved", async () => {
    const dependencies = makeDependencies({ resolved: null });

    const response = await handleSessionsRequest(request("gmap_session=stale-token"), dependencies);

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.sessions.listActiveForUser).not.toHaveBeenCalled();
  });
});
