import { describe, expect, it, vi } from "vitest";

import {
  AuthenticateUser,
  type AuthenticationCredential,
  type AuthenticationCredentialReader,
  type AuthenticationPasswordVerifier,
  type AuthenticationSessionCreator
} from "../../../src/modules/organization/application/authenticate-user";

function credential(overrides: Partial<AuthenticationCredential> = {}): AuthenticationCredential {
  return {
    user: {
      id: "user-1",
      status: "ACTIVE"
    },
    passwordHash: "stored-password-hash",
    ...overrides
  };
}

function makeDependencies(
  options: {
    credential?: AuthenticationCredential | null;
    passwordMatches?: boolean;
  } = {}
): {
  credentials: AuthenticationCredentialReader;
  passwordVerifier: AuthenticationPasswordVerifier;
  sessions: AuthenticationSessionCreator;
} {
  const resolvedCredential = Object.hasOwn(options, "credential")
    ? options.credential
    : credential();

  return {
    credentials: {
      findByLoginIdentifier: vi.fn().mockResolvedValue(resolvedCredential)
    },
    passwordVerifier: {
      verify: vi.fn().mockResolvedValue(options.passwordMatches ?? true)
    },
    sessions: {
      create: vi.fn().mockResolvedValue({
        token: "raw-session-token",
        session: {
          id: "session-1",
          expiresAt: new Date("2026-09-13T20:00:00.000Z")
        }
      })
    }
  };
}

describe("AuthenticateUser", () => {
  it("normalizes credentials, verifies the password and creates a session", async () => {
    const dependencies = makeDependencies();
    const authenticate = new AuthenticateUser(
      dependencies.credentials,
      dependencies.passwordVerifier,
      dependencies.sessions,
      {
        sessionTtlMs: 60 * 60 * 1000
      }
    );
    const now = new Date("2026-09-13T12:00:00.000Z");

    await expect(
      authenticate.execute({
        loginIdentifier: "  Usuario.GMAP  ",
        password: "SenhaForte123",
        userAgent: "Playwright",
        ipAddress: "127.0.0.1",
        now
      })
    ).resolves.toEqual({
      ok: true,
      userId: "user-1",
      sessionId: "session-1",
      sessionToken: "raw-session-token",
      expiresAt: new Date("2026-09-13T20:00:00.000Z")
    });

    expect(dependencies.credentials.findByLoginIdentifier).toHaveBeenCalledWith("usuario.gmap");
    expect(dependencies.passwordVerifier.verify).toHaveBeenCalledWith(
      "SenhaForte123",
      "stored-password-hash"
    );
    expect(dependencies.sessions.create).toHaveBeenCalledWith({
      userId: "user-1",
      expiresAt: new Date("2026-09-13T13:00:00.000Z"),
      userAgent: "Playwright",
      ipAddress: "127.0.0.1",
      now
    });
  });

  it("rejects unknown users without verifying password or creating a session", async () => {
    const dependencies = makeDependencies({ credential: null });
    const authenticate = new AuthenticateUser(
      dependencies.credentials,
      dependencies.passwordVerifier,
      dependencies.sessions
    );

    await expect(
      authenticate.execute({ loginIdentifier: "usuario.gmap", password: "SenhaForte123" })
    ).resolves.toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });

    expect(dependencies.passwordVerifier.verify).not.toHaveBeenCalled();
    expect(dependencies.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects wrong passwords without creating a session", async () => {
    const dependencies = makeDependencies({ passwordMatches: false });
    const authenticate = new AuthenticateUser(
      dependencies.credentials,
      dependencies.passwordVerifier,
      dependencies.sessions
    );

    await expect(
      authenticate.execute({ loginIdentifier: "usuario.gmap", password: "SenhaErrada123" })
    ).resolves.toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });

    expect(dependencies.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects inactive users after verifying credentials", async () => {
    const dependencies = makeDependencies({
      credential: credential({
        user: {
          id: "user-1",
          status: "INACTIVE"
        }
      })
    });
    const authenticate = new AuthenticateUser(
      dependencies.credentials,
      dependencies.passwordVerifier,
      dependencies.sessions
    );

    await expect(
      authenticate.execute({ loginIdentifier: "usuario.gmap", password: "SenhaForte123" })
    ).resolves.toEqual({ ok: false, reason: "USER_INACTIVE" });

    expect(dependencies.passwordVerifier.verify).toHaveBeenCalledWith(
      "SenhaForte123",
      "stored-password-hash"
    );
    expect(dependencies.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects blank login identifiers before reading credentials", async () => {
    const dependencies = makeDependencies();
    const authenticate = new AuthenticateUser(
      dependencies.credentials,
      dependencies.passwordVerifier,
      dependencies.sessions
    );

    await expect(
      authenticate.execute({ loginIdentifier: " ", password: "SenhaForte123" })
    ).rejects.toThrow("Login identifier must not be blank.");

    expect(dependencies.credentials.findByLoginIdentifier).not.toHaveBeenCalled();
    expect(dependencies.sessions.create).not.toHaveBeenCalled();
  });
});
