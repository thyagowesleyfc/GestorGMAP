import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIamSecurityAuditLogger,
  logIamSecurityAuditEvent
} from "../../../src/modules/organization/api/iam-security-audit";

describe("IAM security audit log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes structured events with correlation id and safe fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = createIamSecurityAuditLogger(
      "trace-123",
      () => new Date("2026-09-15T12:00:00.000Z")
    );

    logger.log("iam.login.succeeded", {
      ip_address: "203.0.113.10",
      correlation_id: "should-not-win",
      user_id: "user-1",
      skipped: undefined
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual({
      timestamp: "2026-09-15T12:00:00.000Z",
      level: "info",
      service: "gestor-gmap",
      environment: "test",
      event: "iam.login.succeeded",
      message: "Login succeeded.",
      correlation_id: "trace-123",
      ip_address: "203.0.113.10",
      user_id: "user-1"
    });
  });

  it("uses warning level for rejected and rate limited events", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logIamSecurityAuditEvent(
      "iam.password_recovery.reset_failed",
      {
        reason: "invalid_or_expired_or_policy"
      },
      new Date("2026-09-15T12:00:00.000Z")
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
      level: "warn",
      event: "iam.password_recovery.reset_failed",
      reason: "invalid_or_expired_or_policy"
    });
  });
});
