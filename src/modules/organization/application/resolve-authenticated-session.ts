import type { TeamMembership, UserAccount } from "../domain/iam";

export type ActiveSession = {
  id: string;
  userId: string;
  expiresAt: Date;
};

export type ActiveSessionReader = {
  findActiveByToken(token: string, now?: Date): Promise<ActiveSession | null>;
};

export type AuthenticatedUserContext = {
  user: UserAccount;
  memberships: TeamMembership[];
};

export type AuthenticatedUserContextReader = {
  findByUserId(userId: string): Promise<AuthenticatedUserContext | null>;
};

export type ResolveAuthenticatedSessionInput = {
  sessionToken: string;
  now?: Date;
};

export type ResolvedAuthenticatedSession = {
  session: ActiveSession;
  user: UserAccount;
  memberships: TeamMembership[];
};

export class ResolveAuthenticatedSession {
  constructor(
    private readonly sessions: ActiveSessionReader,
    private readonly users: AuthenticatedUserContextReader
  ) {}

  async execute(
    input: ResolveAuthenticatedSessionInput
  ): Promise<ResolvedAuthenticatedSession | null> {
    const sessionToken = input.sessionToken.trim();

    if (!sessionToken) {
      return null;
    }

    const session = await this.sessions.findActiveByToken(sessionToken, input.now);

    if (session === null) {
      return null;
    }

    const context = await this.users.findByUserId(session.userId);

    if (context === null || context.user.status !== "ACTIVE") {
      return null;
    }

    return {
      session,
      user: context.user,
      memberships: context.memberships.filter(
        (membership) => membership.userId === context.user.id && membership.active
      )
    };
  }
}
