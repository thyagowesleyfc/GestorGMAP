import { describe, expect, it } from "vitest";

import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  SESSION_COOKIE_NAME
} from "../../../src/modules/organization/infrastructure/session/session-cookie";

describe("session cookie", () => {
  it("builds a production cookie with secure session defaults", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const expiresAt = new Date("2026-09-13T13:30:30.000Z");

    expect(
      buildSessionCookie({
        token: "raw-session-token",
        expiresAt,
        now,
        environment: "production"
      })
    ).toEqual({
      name: SESSION_COOKIE_NAME,
      value: "raw-session-token",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
      maxAge: 5430
    });
  });

  it("allows local development cookies without Secure", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const expiresAt = new Date("2026-09-13T12:10:00.000Z");

    expect(
      buildSessionCookie({
        token: "raw-session-token",
        expiresAt,
        now,
        environment: "development"
      })
    ).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 600
    });
  });

  it("uses Secure for unknown deployment environments", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const expiresAt = new Date("2026-09-13T12:10:00.000Z");

    expect(
      buildSessionCookie({
        token: "raw-session-token",
        expiresAt,
        now,
        environment: "staging"
      }).secure
    ).toBe(true);
  });
  it("never emits a negative maxAge", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const expiresAt = new Date("2026-09-13T11:59:59.000Z");

    expect(
      buildSessionCookie({
        token: "raw-session-token",
        expiresAt,
        now,
        environment: "production"
      }).maxAge
    ).toBe(0);
  });

  it("rejects blank tokens", () => {
    expect(() =>
      buildSessionCookie({
        token: "  ",
        expiresAt: new Date("2026-09-13T12:00:00.000Z"),
        environment: "production"
      })
    ).toThrow("Session cookie token must not be blank");
  });

  it("builds an expired cookie for logout", () => {
    expect(buildExpiredSessionCookie({ environment: "production" })).toEqual({
      name: SESSION_COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: new Date(0),
      maxAge: 0
    });
  });
});
