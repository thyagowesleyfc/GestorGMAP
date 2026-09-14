import { describe, expect, it } from "vitest";

import { InMemoryLoginRateLimiter } from "../../../src/modules/organization/infrastructure/security/in-memory-login-rate-limiter";

describe("InMemoryLoginRateLimiter", () => {
  it("allows attempts up to the configured limit and blocks the next one", () => {
    const limiter = new InMemoryLoginRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
    const now = new Date("2026-09-14T12:00:00.000Z");
    const identity = {
      loginIdentifier: "usuario.gmap",
      ipAddress: "127.0.0.1"
    };

    expect(limiter.consume(identity, now)).toEqual({
      allowed: true,
      remainingAttempts: 1,
      resetAt: new Date("2026-09-14T12:01:00.000Z")
    });
    expect(limiter.consume(identity, new Date(now.getTime() + 1_000))).toEqual({
      allowed: true,
      remainingAttempts: 0,
      resetAt: new Date("2026-09-14T12:01:00.000Z")
    });
    expect(limiter.consume(identity, new Date(now.getTime() + 2_000))).toEqual({
      allowed: false,
      retryAfterSeconds: 58,
      resetAt: new Date("2026-09-14T12:01:00.000Z")
    });
  });

  it("starts a new window after the previous window expires", () => {
    const limiter = new InMemoryLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
    const identity = {
      loginIdentifier: "usuario.gmap",
      ipAddress: "127.0.0.1"
    };

    expect(limiter.consume(identity, new Date("2026-09-14T12:00:00.000Z"))).toMatchObject({
      allowed: true
    });
    expect(limiter.consume(identity, new Date("2026-09-14T12:00:30.000Z"))).toMatchObject({
      allowed: false
    });
    expect(limiter.consume(identity, new Date("2026-09-14T12:01:00.000Z"))).toEqual({
      allowed: true,
      remainingAttempts: 0,
      resetAt: new Date("2026-09-14T12:02:00.000Z")
    });
  });

  it("resets an identity after a successful login", () => {
    const limiter = new InMemoryLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
    const identity = {
      loginIdentifier: "usuario.gmap",
      ipAddress: "127.0.0.1"
    };
    const now = new Date("2026-09-14T12:00:00.000Z");

    expect(limiter.consume(identity, now)).toMatchObject({ allowed: true });
    expect(limiter.consume(identity, now)).toMatchObject({ allowed: false });

    limiter.reset(identity);

    expect(limiter.consume(identity, now)).toMatchObject({ allowed: true });
  });

  it("normalizes login identifiers and IP addresses for the same bucket", () => {
    const limiter = new InMemoryLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

    expect(
      limiter.consume(
        {
          loginIdentifier: "  Usuario.GMAP  ",
          ipAddress: "  127.0.0.1  "
        },
        new Date("2026-09-14T12:00:00.000Z")
      )
    ).toMatchObject({ allowed: true });
    expect(
      limiter.consume(
        {
          loginIdentifier: "usuario.gmap",
          ipAddress: "127.0.0.1"
        },
        new Date("2026-09-14T12:00:01.000Z")
      )
    ).toMatchObject({ allowed: false });
  });

  it("keeps separate buckets for different identities", () => {
    const limiter = new InMemoryLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
    const now = new Date("2026-09-14T12:00:00.000Z");

    expect(
      limiter.consume({ loginIdentifier: "usuario.um", ipAddress: "127.0.0.1" }, now)
    ).toMatchObject({ allowed: true });
    expect(
      limiter.consume({ loginIdentifier: "usuario.dois", ipAddress: "127.0.0.1" }, now)
    ).toMatchObject({ allowed: true });
    expect(
      limiter.consume({ loginIdentifier: "usuario.um", ipAddress: "127.0.0.2" }, now)
    ).toMatchObject({ allowed: true });
  });
  it("rejects unusable identities and invalid configuration", () => {
    expect(() => new InMemoryLoginRateLimiter({ maxAttempts: 0 })).toThrow(
      "Login rate limit max attempts must be a positive integer."
    );
    expect(() => new InMemoryLoginRateLimiter({ windowMs: 999 })).toThrow(
      "Login rate limit window must be at least one second."
    );

    const limiter = new InMemoryLoginRateLimiter();

    expect(() => limiter.consume({ loginIdentifier: " ", ipAddress: " " })).toThrow(
      "Login rate limit identity requires login identifier or IP address."
    );
  });
});
