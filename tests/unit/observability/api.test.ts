import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withApiObservability } from "../../../src/shared/observability/api";
import { CORRELATION_ID_HEADER } from "../../../src/shared/observability/correlation";

describe("api observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds correlation id to the response and writes a request log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const request = new Request("http://127.0.0.1:3000/api/health", {
      headers: { [CORRELATION_ID_HEADER]: "trace-1" }
    });

    const response = await withApiObservability(request, "/api/health", () =>
      NextResponse.json({ status: "ok" })
    );

    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe("trace-1");
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0][0] as string)).toMatchObject({
      level: "info",
      service: "gestor-gmap",
      environment: "test",
      event: "api_request_completed",
      message: "API request completed.",
      correlation_id: "trace-1",
      method: "GET",
      path: "/api/health",
      status: 200
    });
  });

  it("returns a generic error payload and logs the correlation id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request("http://127.0.0.1:3000/api/fail", {
      headers: { [CORRELATION_ID_HEADER]: "trace-error" }
    });

    const response = await withApiObservability(request, "/api/fail", () => {
      throw new Error("database password leaked");
    });

    await expect(response.json()).resolves.toEqual({
      error: "Erro interno do servidor.",
      correlation_id: "trace-error"
    });
    expect(response.status).toBe(500);
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe("trace-error");
    expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({
      level: "error",
      event: "api_request_failed",
      message: "API request failed.",
      correlation_id: "trace-error",
      error_name: "Error",
      status: 500
    });
  });
});
