export type UserStatus = "ACTIVE" | "INACTIVE";
export type MembershipRole = "MEMBRO" | "LIDER";

export type Person = {
  id: string;
  displayName: string;
};

export type UserAccount = {
  id: string;
  personId: string;
  status: UserStatus;
  isTechnicalSuperuser: boolean;
};

export type Team = {
  id: string;
  name: string;
};

export type BusinessScope =
  | {
      type: "GLOBAL";
    }
  | {
      type: "GRE";
      greCode: string;
    };

export type TeamMembership = {
  id: string;
  userId: string;
  teamId: string;
  role: MembershipRole;
  scope: BusinessScope;
  active: boolean;
};

export function createGlobalScope(): BusinessScope {
  return { type: "GLOBAL" };
}

export function createGreScope(greCode: string): BusinessScope {
  const normalizedGreCode = greCode.trim();

  if (!normalizedGreCode) {
    throw new Error("GRE scope requires a code.");
  }

  return {
    type: "GRE",
    greCode: normalizedGreCode
  };
}

export function isActiveUser(user: UserAccount): boolean {
  return user.status === "ACTIVE";
}

export function isActiveMembership(membership: TeamMembership): boolean {
  return membership.active;
}

export function isLeaderMembership(membership: TeamMembership): boolean {
  return membership.role === "LIDER";
}

export function scopeAllows(
  membershipScope: BusinessScope,
  requestedScope: BusinessScope
): boolean {
  if (membershipScope.type === "GLOBAL") {
    return true;
  }

  if (requestedScope.type === "GLOBAL") {
    return false;
  }

  return membershipScope.greCode === requestedScope.greCode;
}

export function hasBusinessAuthority(
  user: UserAccount,
  memberships: TeamMembership[],
  requestedScope?: BusinessScope,
  requiredTeamId?: string
): boolean {
  if (!isActiveUser(user)) {
    return false;
  }

  return memberships.some((membership) => {
    if (membership.userId !== user.id || !isActiveMembership(membership)) {
      return false;
    }

    if (requiredTeamId !== undefined && membership.teamId !== requiredTeamId) {
      return false;
    }

    return requestedScope ? scopeAllows(membership.scope, requestedScope) : true;
  });
}
