import type { PrismaClient } from "@prisma/client";

import type { AuthenticatedUserContextReader } from "../../application/resolve-authenticated-session";
import {
  createGlobalScope,
  createGreScope,
  type BusinessScope,
  type TeamMembership
} from "../../domain/iam";

type PrismaAuthenticatedUserContextClient = Pick<PrismaClient, "userAccount">;

type PrismaMembershipProjection = {
  id: string;
  userId: string;
  teamId: string;
  role: TeamMembership["role"];
  scopeType: "GLOBAL" | "GRE";
  greCode: string | null;
  active: boolean;
};

function toBusinessScope(membership: PrismaMembershipProjection): BusinessScope {
  if (membership.scopeType === "GLOBAL") {
    return createGlobalScope();
  }

  if (membership.greCode === null) {
    throw new Error("GRE membership requires a GRE code.");
  }

  return createGreScope(membership.greCode);
}

function toTeamMembership(membership: PrismaMembershipProjection): TeamMembership {
  return {
    id: membership.id,
    userId: membership.userId,
    teamId: membership.teamId,
    role: membership.role,
    scope: toBusinessScope(membership),
    active: membership.active
  };
}

export class PrismaAuthenticatedUserContextReader implements AuthenticatedUserContextReader {
  constructor(private readonly prisma: PrismaAuthenticatedUserContextClient) {}

  async findByUserId(userId: string) {
    const user = await this.prisma.userAccount.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        personId: true,
        status: true,
        isTechnicalSuperuser: true,
        memberships: {
          select: {
            id: true,
            userId: true,
            teamId: true,
            role: true,
            scopeType: true,
            greCode: true,
            active: true
          },
          orderBy: {
            id: "asc"
          }
        }
      }
    });

    if (user === null) {
      return null;
    }

    return {
      user: {
        id: user.id,
        personId: user.personId,
        status: user.status,
        isTechnicalSuperuser: user.isTechnicalSuperuser
      },
      memberships: user.memberships.map(toTeamMembership)
    };
  }
}
