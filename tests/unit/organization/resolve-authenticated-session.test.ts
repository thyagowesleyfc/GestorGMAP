import { describe, expect, it, vi } from "vitest";

import {
  ResolveAuthenticatedSession,
  type ActiveSessionReader,
  type AuthenticatedUserContextReader
} from "../../../src/modules/organization/application/resolve-authenticated-session";
import {
  createGlobalScope,
  createGreScope,
  hasBusinessAuthority,
  type TeamMembership,
  type UserAccount
} from "../../../src/modules/organization/domain/iam";

const activeUser: UserAccount = {
  id: "user-1",
  personId: "person-1",
  status: "ACTIVE",
  isTechnicalSuperuser: false
};

const activeSession = {
  id: "session-1",
  userId: activeUser.id,
  expiresAt: new Date("2026-09-14T18:00:00.000Z")
};

function membership(overrides: Partial<TeamMembership> = {}): TeamMembership {
  return {
    id: "membership-1",
    userId: activeUser.id,
    teamId: "team-1",
    role: "MEMBRO",
    scope: createGreScope("GRE-01"),
    active: true,
    ...overrides
  };
}

function makeDependencies(
  options: {
    session?: typeof activeSession | null;
    user?: UserAccount | null;
    memberships?: TeamMembership[];
  } = {}
): {
  sessions: ActiveSessionReader;
  users: AuthenticatedUserContextReader;
} {
  const resolvedSession = options.session === undefined ? activeSession : options.session;
  const resolvedUser = options.user === undefined ? activeUser : options.user;
  const memberships = options.memberships ?? [membership()];

  return {
    sessions: {
      findActiveByToken: vi.fn().mockResolvedValue(resolvedSession)
    },
    users: {
      findByUserId: vi.fn().mockResolvedValue(
        resolvedUser === null
          ? null
          : {
              user: resolvedUser,
              memberships
            }
      )
    }
  };
}

describe("ResolveAuthenticatedSession", () => {
  it("resolves an active session into an authenticated IAM context", async () => {
    const now = new Date("2026-09-14T12:00:00.000Z");
    const inactiveMembership = membership({ id: "membership-2", active: false });
    const otherUserMembership = membership({
      id: "membership-3",
      userId: "other-user",
      scope: createGlobalScope()
    });
    const dependencies = makeDependencies({
      memberships: [membership(), inactiveMembership, otherUserMembership]
    });
    const resolver = new ResolveAuthenticatedSession(dependencies.sessions, dependencies.users);

    await expect(resolver.execute({ sessionToken: "  raw-session-token  ", now })).resolves.toEqual(
      {
        session: activeSession,
        user: activeUser,
        memberships: [membership()]
      }
    );
    expect(dependencies.sessions.findActiveByToken).toHaveBeenCalledWith("raw-session-token", now);
    expect(dependencies.users.findByUserId).toHaveBeenCalledWith(activeUser.id);
  });

  it("keeps technical superusers from receiving business authority without membership", async () => {
    const technicalSuperuser: UserAccount = {
      ...activeUser,
      isTechnicalSuperuser: true
    };
    const dependencies = makeDependencies({ user: technicalSuperuser, memberships: [] });
    const resolver = new ResolveAuthenticatedSession(dependencies.sessions, dependencies.users);

    const result = await resolver.execute({ sessionToken: "raw-session-token" });

    expect(result).toEqual({
      session: activeSession,
      user: technicalSuperuser,
      memberships: []
    });
    expect(result).not.toBeNull();
    expect(hasBusinessAuthority(result!.user, result!.memberships)).toBe(false);
  });
  it("returns null for blank or inactive sessions without loading the IAM context", async () => {
    const blankDependencies = makeDependencies();
    const inactiveSessionDependencies = makeDependencies({ session: null });

    await expect(
      new ResolveAuthenticatedSession(blankDependencies.sessions, blankDependencies.users).execute({
        sessionToken: " "
      })
    ).resolves.toBeNull();
    expect(blankDependencies.sessions.findActiveByToken).not.toHaveBeenCalled();
    expect(blankDependencies.users.findByUserId).not.toHaveBeenCalled();

    await expect(
      new ResolveAuthenticatedSession(
        inactiveSessionDependencies.sessions,
        inactiveSessionDependencies.users
      ).execute({ sessionToken: "raw-session-token" })
    ).resolves.toBeNull();
    expect(inactiveSessionDependencies.users.findByUserId).not.toHaveBeenCalled();
  });

  it("returns null when the user context is missing or inactive", async () => {
    const missingUserDependencies = makeDependencies({ user: null });
    const inactiveUserDependencies = makeDependencies({
      user: {
        ...activeUser,
        status: "INACTIVE"
      }
    });

    await expect(
      new ResolveAuthenticatedSession(
        missingUserDependencies.sessions,
        missingUserDependencies.users
      ).execute({ sessionToken: "raw-session-token" })
    ).resolves.toBeNull();
    await expect(
      new ResolveAuthenticatedSession(
        inactiveUserDependencies.sessions,
        inactiveUserDependencies.users
      ).execute({ sessionToken: "raw-session-token" })
    ).resolves.toBeNull();
  });
});
