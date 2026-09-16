import { describe, expect, it } from "vitest";

import {
  createGlobalScope,
  createGreScope,
  hasBusinessAuthority,
  isLeaderMembership,
  type BusinessScope,
  type MembershipRole,
  type TeamMembership,
  type UserAccount,
  type UserStatus
} from "../../../src/modules/organization/domain/iam";

const userId = "user-1";
const teamId = "team-gmap";
const managementTeamId = "team-gerencia";
const triageTeamId = "team-triagem";

function user(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: userId,
    personId: "person-1",
    status: "ACTIVE",
    isTechnicalSuperuser: false,
    ...overrides
  };
}

function membership(overrides: Partial<TeamMembership> = {}): TeamMembership {
  return {
    id: "membership-1",
    userId,
    teamId,
    role: "MEMBRO",
    scope: createGreScope("GRE-01"),
    active: true,
    ...overrides
  };
}

type AuthorizationCase = {
  name: string;
  userStatus: UserStatus;
  technicalSuperuser: boolean;
  memberships: TeamMembership[];
  requestedScope?: BusinessScope;
  requiredTeamId?: string;
  expected: boolean;
};

const authorizationCases: AuthorizationCase[] = [
  {
    name: "active user with MEMBRO membership in matching GRE scope",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ role: "MEMBRO", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-01"),
    expected: true
  },
  {
    name: "active user with LIDER membership in matching GRE scope",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ role: "LIDER", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-01"),
    expected: true
  },
  {
    name: "inactive user with valid membership",
    userStatus: "INACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ role: "LIDER", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-01"),
    expected: false
  },
  {
    name: "active user without team membership",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [],
    requestedScope: createGreScope("GRE-01"),
    expected: false
  },
  {
    name: "active user with inactive membership",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ active: false, role: "LIDER", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-01"),
    expected: false
  },
  {
    name: "active user with another user's membership",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ userId: "user-2", role: "LIDER", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-01"),
    expected: false
  },
  {
    name: "technical superuser without membership",
    userStatus: "ACTIVE",
    technicalSuperuser: true,
    memberships: [],
    requestedScope: createGreScope("GRE-01"),
    expected: false
  },
  {
    name: "technical superuser with active matching membership",
    userStatus: "ACTIVE",
    technicalSuperuser: true,
    memberships: [membership({ role: "LIDER", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-01"),
    expected: true
  },
  {
    name: "inactive technical superuser with GLOBAL membership",
    userStatus: "INACTIVE",
    technicalSuperuser: true,
    memberships: [membership({ role: "MEMBRO", scope: createGlobalScope() })],
    requestedScope: createGlobalScope(),
    expected: false
  },
  {
    name: "management team with GLOBAL scope accessing a GRE scope",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [
      membership({ teamId: managementTeamId, role: "LIDER", scope: createGlobalScope() })
    ],
    requestedScope: createGreScope("GRE-02"),
    requiredTeamId: managementTeamId,
    expected: true
  },
  {
    name: "management team with GLOBAL scope accessing GLOBAL scope",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [
      membership({ teamId: managementTeamId, role: "MEMBRO", scope: createGlobalScope() })
    ],
    requestedScope: createGlobalScope(),
    requiredTeamId: managementTeamId,
    expected: true
  },
  {
    name: "non-management team with GLOBAL scope cannot pass a management gate",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ teamId: triageTeamId, role: "LIDER", scope: createGlobalScope() })],
    requestedScope: createGreScope("GRE-02"),
    requiredTeamId: managementTeamId,
    expected: false
  },
  {
    name: "GRE scope trying to access another GRE",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ role: "MEMBRO", scope: createGreScope("GRE-01") })],
    requestedScope: createGreScope("GRE-02"),
    expected: false
  },
  {
    name: "GRE scope trying to access GLOBAL scope",
    userStatus: "ACTIVE",
    technicalSuperuser: false,
    memberships: [membership({ role: "LIDER", scope: createGreScope("GRE-01") })],
    requestedScope: createGlobalScope(),
    expected: false
  }
];

describe("IAM authorization matrix", () => {
  it.each(authorizationCases)("evaluates $name", (testCase) => {
    expect(
      hasBusinessAuthority(
        user({
          status: testCase.userStatus,
          isTechnicalSuperuser: testCase.technicalSuperuser
        }),
        testCase.memberships,
        testCase.requestedScope,
        testCase.requiredTeamId
      )
    ).toBe(testCase.expected);
  });

  it.each([
    ["MEMBRO", false],
    ["LIDER", true]
  ] satisfies Array<[MembershipRole, boolean]>)(
    "identifies role %s for workflows that require leadership",
    (role, expected) => {
      expect(isLeaderMembership(membership({ role }))).toBe(expected);
    }
  );
});
