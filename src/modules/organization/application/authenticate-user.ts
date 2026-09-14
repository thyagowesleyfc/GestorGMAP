import { normalizeLoginIdentifier } from "../domain/login-identifier";
import type { UserStatus } from "../domain/iam";

export type AuthenticationUser = {
  id: string;
  status: UserStatus;
};

export type AuthenticationCredential = {
  user: AuthenticationUser;
  passwordHash: string;
};

export type AuthenticationCredentialReader = {
  findByLoginIdentifier(loginIdentifier: string): Promise<AuthenticationCredential | null>;
};

export type AuthenticationPasswordVerifier = {
  verify(password: string, storedHash: string): Promise<boolean>;
};

export type AuthenticationSessionCreator = {
  create(input: {
    userId: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
    now?: Date;
  }): Promise<{
    token: string;
    session: {
      id: string;
      expiresAt: Date;
    };
  }>;
};

export type AuthenticateUserInput = {
  loginIdentifier: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
  now?: Date;
};

export type AuthenticateUserResult =
  | {
      ok: true;
      userId: string;
      sessionId: string;
      sessionToken: string;
      expiresAt: Date;
    }
  | {
      ok: false;
      reason: "INVALID_CREDENTIALS" | "USER_INACTIVE";
    };

export type AuthenticateUserOptions = {
  sessionTtlMs?: number;
};

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class AuthenticateUser {
  private readonly sessionTtlMs: number;

  constructor(
    private readonly credentials: AuthenticationCredentialReader,
    private readonly passwordVerifier: AuthenticationPasswordVerifier,
    private readonly sessions: AuthenticationSessionCreator,
    options: AuthenticateUserOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  async execute(input: AuthenticateUserInput): Promise<AuthenticateUserResult> {
    const loginIdentifier = normalizeLoginIdentifier(input.loginIdentifier);
    const credential = await this.credentials.findByLoginIdentifier(loginIdentifier);

    if (credential === null) {
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    const passwordMatches = await this.passwordVerifier.verify(
      input.password,
      credential.passwordHash
    );

    if (!passwordMatches) {
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    if (credential.user.status !== "ACTIVE") {
      return { ok: false, reason: "USER_INACTIVE" };
    }

    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const createdSession = await this.sessions.create({
      userId: credential.user.id,
      expiresAt,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
      now
    });

    return {
      ok: true,
      userId: credential.user.id,
      sessionId: createdSession.session.id,
      sessionToken: createdSession.token,
      expiresAt: createdSession.session.expiresAt
    };
  }
}
