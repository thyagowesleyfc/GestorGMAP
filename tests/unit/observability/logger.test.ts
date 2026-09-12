import { afterEach, describe, expect, it, vi } from "vitest";

import { logStructured } from "../../../src/shared/observability/logger";

describe("structured logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one JSON line without undefined fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logStructured(
      "info",
      "api_request_completed",
      "API request completed.",
      {
        correlation_id: "trace-123",
        skipped: undefined,
        status: 200
      },
      new Date("2026-09-12T12:00:00.000Z")
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual({
      timestamp: "2026-09-12T12:00:00.000Z",
      level: "info",
      service: "gestor-gmap",
      environment: "test",
      event: "api_request_completed",
      message: "API request completed.",
      correlation_id: "trace-123",
      status: 200
    });
  });
});
