import { describe, expect, it, vi } from "vitest";

import { createHealthPayload, createReadinessPayload } from "../../../src/shared/health/checks";

describe("health checks", () => {
  const now = new Date("2026-09-11T12:00:00.000Z");

  it("creates a liveness payload without external dependencies", () => {
    expect(createHealthPayload(now)).toEqual({
      service: "gestor-gmap",
      status: "ok",
      timestamp: "2026-09-11T12:00:00.000Z"
    });
  });

  it("marks readiness as ok when the database check succeeds", async () => {
    const result = await createReadinessPayload(vi.fn().mockResolvedValue(undefined), now);

    expect(result).toEqual({
      httpStatus: 200,
      payload: {
        service: "gestor-gmap",
        status: "ok",
        timestamp: "2026-09-11T12:00:00.000Z",
        dependencies: {
          database: "ok"
        }
      }
    });
  });

  it("marks readiness as unavailable when the database check fails", async () => {
    const result = await createReadinessPayload(
      vi.fn().mockRejectedValue(new Error("offline")),
      now
    );

    expect(result).toEqual({
      httpStatus: 503,
      payload: {
        service: "gestor-gmap",
        status: "error",
        timestamp: "2026-09-11T12:00:00.000Z",
        dependencies: {
          database: "error"
        }
      }
    });
  });
});
