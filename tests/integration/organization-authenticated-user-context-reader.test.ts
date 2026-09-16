import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaAuthenticatedUserContextReader } from "../../src/modules/organization/infrastructure/authentication/prisma-authenticated-user-context-reader";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl
    },
    timeout: 90000
  });
}

describe("PrismaAuthenticatedUserContextReader", () => {
  it("loads the minimal IAM context with scoped memberships", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl
        }
      }
    });

    try {
      await runPrismaMigrateDeploy(databaseUrl);
      await prisma.$connect();

      const person = await prisma.person.create({
        data: {
          displayName: "Pessoa Contexto"
        }
      });
      const user = await prisma.userAccount.create({
        data: {
          personId: person.id,
          loginIdentifier: "pessoa.contexto",
          isTechnicalSuperuser: true
        }
      });
      const globalTeam = await prisma.team.create({
        data: {
          name: "Gerencia"
        }
      });
      const greTeam = await prisma.team.create({
        data: {
          name: "GRE 01"
        }
      });
      const inactiveTeam = await prisma.team.create({
        data: {
          name: "Equipe Inativa"
        }
      });
      await prisma.gre.createMany({
        data: [
          {
            code: "GRE-01",
            name: "1a Gerencia Regional de Educacao"
          },
          {
            code: "GRE-02",
            name: "2a Gerencia Regional de Educacao"
          }
        ]
      });
      const globalMembership = await prisma.teamMembership.create({
        data: {
          userId: user.id,
          teamId: globalTeam.id,
          role: "LIDER",
          scopeType: "GLOBAL",
          active: true
        }
      });
      const greMembership = await prisma.teamMembership.create({
        data: {
          userId: user.id,
          teamId: greTeam.id,
          role: "MEMBRO",
          scopeType: "GRE",
          greCode: "GRE-01",
          active: true
        }
      });
      const inactiveMembership = await prisma.teamMembership.create({
        data: {
          userId: user.id,
          teamId: inactiveTeam.id,
          role: "MEMBRO",
          scopeType: "GRE",
          greCode: "GRE-02",
          active: false
        }
      });
      const reader = new PrismaAuthenticatedUserContextReader(prisma);

      await expect(reader.findByUserId(user.id)).resolves.toEqual({
        user: {
          id: user.id,
          personId: person.id,
          status: "ACTIVE",
          isTechnicalSuperuser: true
        },
        memberships: expect.arrayContaining([
          {
            id: globalMembership.id,
            userId: user.id,
            teamId: globalTeam.id,
            role: "LIDER",
            scope: {
              type: "GLOBAL"
            },
            active: true
          },
          {
            id: greMembership.id,
            userId: user.id,
            teamId: greTeam.id,
            role: "MEMBRO",
            scope: {
              type: "GRE",
              greCode: "GRE-01"
            },
            active: true
          },
          {
            id: inactiveMembership.id,
            userId: user.id,
            teamId: inactiveTeam.id,
            role: "MEMBRO",
            scope: {
              type: "GRE",
              greCode: "GRE-02"
            },
            active: false
          }
        ])
      });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("returns users without memberships and null for unknown users", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl
        }
      }
    });

    try {
      await runPrismaMigrateDeploy(databaseUrl);
      await prisma.$connect();

      const person = await prisma.person.create({
        data: {
          displayName: "Pessoa Sem Membership"
        }
      });
      const inactiveUser = await prisma.userAccount.create({
        data: {
          personId: person.id,
          loginIdentifier: "pessoa.sem.membership",
          status: "INACTIVE"
        }
      });
      const reader = new PrismaAuthenticatedUserContextReader(prisma);

      await expect(reader.findByUserId(inactiveUser.id)).resolves.toEqual({
        user: {
          id: inactiveUser.id,
          personId: person.id,
          status: "INACTIVE",
          isTechnicalSuperuser: false
        },
        memberships: []
      });
      await expect(reader.findByUserId("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
