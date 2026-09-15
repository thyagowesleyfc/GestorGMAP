import { describe, expect, it } from "vitest";

import {
  forbiddenCsrfResponse,
  isSameOriginMutationRequest
} from "../../../src/modules/organization/api/csrf-protection";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/logout", {
    headers,
    method: "POST"
  });
}

describe("CSRF protection", () => {
  it("accepts requests without browser origin headers", () => {
    expect(isSameOriginMutationRequest(request())).toBe(true);
  });

  it("accepts same-origin Origin and Referer headers", () => {
    expect(
      isSameOriginMutationRequest(
        request({
          origin: "http://localhost",
          referer: "http://localhost/sessoes"
        })
      )
    ).toBe(true);
  });

  it("rejects cross-origin or malformed browser origin headers", () => {
    expect(isSameOriginMutationRequest(request({ origin: "https://evil.example" }))).toBe(false);
    expect(isSameOriginMutationRequest(request({ referer: "https://evil.example/page" }))).toBe(
      false
    );
    expect(isSameOriginMutationRequest(request({ origin: "null" }))).toBe(false);
  });

  it("returns a public no-store forbidden response", async () => {
    const response = forbiddenCsrfResponse();

    await expect(response.json()).resolves.toEqual({
      error: "Origem da requisi\u00e7\u00e3o n\u00e3o permitida."
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
