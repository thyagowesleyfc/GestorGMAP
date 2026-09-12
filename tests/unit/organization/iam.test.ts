import { describe, expect, it } from "vitest";

import {
  createGlobalScope,
  createGreScope,
  hasBusinessAuthority,
  isLeaderMembership,
  scopeAllows,
  type TeamMembership,
  type UserAccount
} from "../../../src/modules/organization/domain/iam";

const activeUser: UserAccount = {
  id: "user-1",
  personId: "person-1",
  status: "ACTIVE",
  isTechnicalSuperuser: false
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

describe("IAM organization domain", () => {
  it("grants business authority to an active user with an active membership", () => {
    expect(hasBusinessAuthority(activeUser, [membership()])).toBe(true);
  });

  it("denies business authority to inactive users even with membership", () => {
    expect(
      hasBusinessAuthority(
        {
          ...activeUser,
          status: "INACTIVE"
        },
        [membership()]
      )
    ).toBe(false);
  });

  it("denies business authority when the membership is inactive", () => {
    expect(hasBusinessAuthority(activeUser, [membership({ active: false })])).toBe(false);
  });

  it("does not give business authority to a technical superuser without membership", () => {
    expect(
      hasBusinessAuthority(
        {
          ...activeUser,
          isTechnicalSuperuser: true
        },
        []
      )
    ).toBe(false);
  });

  it("matches memberships by user id", () => {
    expect(hasBusinessAuthority(activeUser, [membership({ userId: "other-user" })])).toBe(false);
  });

  it("identifies leader memberships", () => {
    expect(isLeaderMembership(membership({ role: "LIDER" }))).toBe(true);
    expect(isLeaderMembership(membership({ role: "MEMBRO" }))).toBe(false);
  });

  it("allows GLOBAL scope to operate globally or in any GRE", () => {
    const globalScope = createGlobalScope();

    expect(scopeAllows(globalScope, createGlobalScope())).toBe(true);
    expect(scopeAllows(globalScope, createGreScope("GRE-01"))).toBe(true);
  });

  it("restricts GRE scope to the same GRE", () => {
    const greScope = createGreScope("GRE-01");

    expect(scopeAllows(greScope, createGreScope("GRE-01"))).toBe(true);
    expect(scopeAllows(greScope, createGreScope("GRE-02"))).toBe(false);
    expect(scopeAllows(greScope, createGlobalScope())).toBe(false);
  });

  it("requires a GRE code for GRE scoped memberships", () => {
    expect(createGreScope(" GRE-01 ")).toEqual({
      type: "GRE",
      greCode: "GRE-01"
    });
    expect(() => createGreScope(" ")).toThrow("GRE scope requires a code.");
  });

  it("checks requested scope when evaluating business authority", () => {
    expect(hasBusinessAuthority(activeUser, [membership()], createGreScope("GRE-01"))).toBe(true);
    expect(hasBusinessAuthority(activeUser, [membership()], createGreScope("GRE-02"))).toBe(false);
  });
});
