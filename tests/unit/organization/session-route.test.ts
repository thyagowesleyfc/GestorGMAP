import { describe, expect, it, vi } from "vitest";

import { handleSessionRequest } from "../../../src/modules/organization/api/session-route";

function request(cookie?: string): Request {
  return new Request("http://localhost/api/auth/session", {
    headers: cookie === undefined ? undefined : { cookie },
    method: "GET"
  });
}

function makeDependencies(result: Awaited<ReturnType<typeof resolvedSession>> | null) {
  return {
    environment: "test" as const,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    resolveSession: {
      execute: vi.fn().mockResolvedValue(result)
    }
  };
}

async function resolvedSession() {
  return {
    session: {
      id: "session-1",
      userId: "user-1",
      expiresAt: new Date("2026-09-14T20:00:00.000Z")
    },
    user: {
      id: "user-1",
      personId: "person-1",
      status: "ACTIVE" as const,
      isTechnicalSuperuser: true
    },
    memberships: [
      {
        id: "membership-1",
        userId: "user-1",
        teamId: "team-1",
        role: "LIDER" as const,
        scope: {
          type: "GLOBAL" as const
        },
        active: true
      },
      {
        id: "membership-2",
        userId: "user-1",
        teamId: "team-2",
        role: "MEMBRO" as const,
        scope: {
          type: "GRE" as const,
          greCode: "GRE-01"
        },
        active: true
      }
    ]
  };
}

describe("handleSessionRequest", () => {
  it("returns the current authenticated session context without exposing the token", async () => {
    const dependencies = makeDependencies(await resolvedSession());

    const response = await handleSessionRequest(
      request("gmap_session=raw-session-token"),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      user: {
        id: "user-1",
        person_id: "person-1",
        is_technical_superuser: true
      },
      memberships: [
        {
          id: "membership-1",
          team_id: "team-1",
          role: "LIDER",
          scope: {
            type: "GLOBAL"
          }
        },
        {
          id: "membership-2",
          team_id: "team-2",
          role: "MEMBRO",
          scope: {
            type: "GRE",
            gre_code: "GRE-01"
          }
        }
      ],
      session: {
        expires_at: "2026-09-14T20:00:00.000Z"
      }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(dependencies.resolveSession.execute).toHaveBeenCalledWith({
      sessionToken: "raw-session-token",
      now: new Date("2026-09-14T12:00:00.000Z")
    });
  });

  it("returns 401 and expires the cookie when the cookie is missing", async () => {
    const dependencies = makeDependencies(await resolvedSession());

    const response = await handleSessionRequest(request(), dependencies);

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("gmap_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.resolveSession.execute).not.toHaveBeenCalled();
  });

  it("returns 401 and expires the cookie when the session cannot be resolved", async () => {
    const dependencies = makeDependencies(null);

    const response = await handleSessionRequest(request("gmap_session=stale-token"), dependencies);

    await expect(response.json()).resolves.toEqual({
      error: "Sessao nao autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("decodes encoded session tokens from the cookie", async () => {
    const dependencies = makeDependencies(await resolvedSession());

    await handleSessionRequest(request("gmap_session=raw%3Asession%3Atoken"), dependencies);

    expect(dependencies.resolveSession.execute).toHaveBeenCalledWith({
      sessionToken: "raw:session:token",
      now: new Date("2026-09-14T12:00:00.000Z")
    });
  });
});
