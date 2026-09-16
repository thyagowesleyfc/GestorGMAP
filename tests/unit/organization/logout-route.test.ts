import { describe, expect, it, vi } from "vitest";

import type { IamSecurityAuditLogger } from "../../../src/modules/organization/api/iam-security-audit";
import { handleLogoutRequest } from "../../../src/modules/organization/api/logout-route";

function request(cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/logout", {
    headers: cookie === undefined ? headers : { cookie, ...headers },
    method: "POST"
  });
}

function makeAuditLogger(): IamSecurityAuditLogger {
  return {
    log: vi.fn()
  };
}

function makeDependencies() {
  return {
    audit: makeAuditLogger(),
    environment: "test" as const,
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    sessions: {
      revokeByToken: vi.fn().mockResolvedValue(1)
    }
  };
}

describe("handleLogoutRequest", () => {
  it("revokes the session token from the cookie and expires the session cookie", async () => {
    const dependencies = makeDependencies();

    const response = await handleLogoutRequest(
      request("other=value; gmap_session=raw-session-token; theme=light"),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(dependencies.sessions.revokeByToken).toHaveBeenCalledWith(
      "raw-session-token",
      new Date("2026-09-14T12:00:00.000Z")
    );
    expect(response.headers.get("set-cookie")).toContain("gmap_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(dependencies.audit.log).toHaveBeenCalledWith("iam.logout.succeeded", {
      had_session_cookie: true,
      ip_address: null
    });
    expect(JSON.stringify(vi.mocked(dependencies.audit.log).mock.calls)).not.toContain(
      "raw-session-token"
    );
  });

  it("expires the cookie even when there is no session cookie", async () => {
    const dependencies = makeDependencies();

    const response = await handleLogoutRequest(request(), dependencies);

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(dependencies.sessions.revokeByToken).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.audit.log).toHaveBeenCalledWith("iam.logout.succeeded", {
      had_session_cookie: false,
      ip_address: null
    });
  });

  it("blocks cross-origin logout without revoking the session", async () => {
    const dependencies = makeDependencies();

    const response = await handleLogoutRequest(
      request("gmap_session=raw-session-token", { origin: "https://evil.example" }),
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Origem da requisi\u00e7\u00e3o n\u00e3o permitida."
    });
    expect(response.status).toBe(403);
    expect(dependencies.sessions.revokeByToken).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(dependencies.audit.log).not.toHaveBeenCalled();
  });
  it("decodes encoded session tokens from the cookie", async () => {
    const dependencies = makeDependencies();

    await handleLogoutRequest(request("gmap_session=raw%3Asession%3Atoken"), dependencies);

    expect(dependencies.sessions.revokeByToken).toHaveBeenCalledWith(
      "raw:session:token",
      new Date("2026-09-14T12:00:00.000Z")
    );
  });
});
