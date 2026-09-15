import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaPasswordRecoveryRequestStore } from "../../src/modules/organization/infrastructure/authentication/prisma-password-recovery-request-store";
import { PrismaPasswordRecoveryResetStore } from "../../src/modules/organization/infrastructure/authentication/prisma-password-recovery-reset-store";
import { PrismaPasswordRecoveryUserReader } from "../../src/modules/organization/infrastructure/authentication/prisma-password-recovery-user-reader";

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

describe("Prisma password recovery adapters", () => {
  it("loads users and stores only recovery token hashes", async () => {
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
          displayName: "Pessoa Recuperacao"
        }
      });
      const user = await prisma.userAccount.create({
        data: {
          personId: person.id,
          loginIdentifier: "pessoa.recuperacao"
        }
      });
      const inactivePerson = await prisma.person.create({
        data: {
          displayName: "Pessoa Recuperacao Inativa"
        }
      });
      const inactiveUser = await prisma.userAccount.create({
        data: {
          personId: inactivePerson.id,
          loginIdentifier: "pessoa.recuperacao.inativa",
          status: "INACTIVE"
        }
      });
      const userReader = new PrismaPasswordRecoveryUserReader(prisma);
      const requestStore = new PrismaPasswordRecoveryRequestStore(prisma);
      const resetStore = new PrismaPasswordRecoveryResetStore(prisma);
      const now = new Date("2026-09-15T10:00:00.000Z");
      const expiresAt = new Date("2026-09-15T10:15:00.000Z");

      await expect(userReader.findByLoginIdentifier("  Pessoa.Recuperacao  ")).resolves.toEqual({
        id: user.id,
        status: "ACTIVE"
      });
      await expect(userReader.findByLoginIdentifier("pessoa.recuperacao.inativa")).resolves.toEqual(
        {
          id: inactiveUser.id,
          status: "INACTIVE"
        }
      );
      await expect(userReader.findByLoginIdentifier("pessoa.inexistente")).resolves.toBeNull();

      await requestStore.create({
        userId: user.id,
        recoveryTokenHash: "sha256:recovery-token-hash",
        expiresAt,
        now
      });

      const storedRequest = await prisma.passwordRecoveryRequest.findFirstOrThrow({
        where: {
          userId: user.id
        }
      });

      expect(storedRequest.recoveryTokenHash).toBe("sha256:recovery-token-hash");
      expect(storedRequest.recoveryTokenHash).not.toContain("raw-recovery-token");
      expect(storedRequest.expiresAt).toEqual(expiresAt);
      expect(storedRequest.usedAt).toBeNull();
      expect(storedRequest.createdAt).toEqual(now);
      expect(storedRequest.updatedAt).toEqual(now);

      await prisma.passwordCredential.create({
        data: {
          userId: user.id,
          passwordHash: "scrypt:old-password-hash",
          passwordUpdatedAt: now
        }
      });
      await prisma.userSession.create({
        data: {
          userId: user.id,
          sessionTokenHash: "sha256:active-session-token-hash",
          expiresAt: new Date("2026-09-15T12:00:00.000Z"),
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now
        }
      });
      await prisma.userSession.create({
        data: {
          userId: user.id,
          sessionTokenHash: "sha256:expired-session-token-hash",
          expiresAt: new Date("2026-09-15T10:05:00.000Z"),
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now
        }
      });

      const resetAt = new Date("2026-09-15T10:10:00.000Z");

      await expect(
        resetStore.resetPassword({
          recoveryTokenHash: "sha256:recovery-token-hash",
          passwordHash: "scrypt:new-password-hash",
          now: resetAt
        })
      ).resolves.toBe(true);

      const consumedRequest = await prisma.passwordRecoveryRequest.findFirstOrThrow({
        where: {
          userId: user.id
        }
      });
      const updatedCredential = await prisma.passwordCredential.findUniqueOrThrow({
        where: {
          userId: user.id
        }
      });
      const sessions = await prisma.userSession.findMany({
        where: {
          userId: user.id
        },
        orderBy: {
          sessionTokenHash: "asc"
        }
      });

      expect(consumedRequest.usedAt).toEqual(resetAt);
      expect(updatedCredential.passwordHash).toBe("scrypt:new-password-hash");
      expect(updatedCredential.passwordUpdatedAt).toEqual(resetAt);
      expect(sessions).toEqual([
        expect.objectContaining({
          sessionTokenHash: "sha256:active-session-token-hash",
          revokedAt: resetAt
        }),
        expect.objectContaining({
          sessionTokenHash: "sha256:expired-session-token-hash",
          revokedAt: null
        })
      ]);
      await expect(
        resetStore.resetPassword({
          recoveryTokenHash: "sha256:recovery-token-hash",
          passwordHash: "scrypt:another-password-hash",
          now: new Date("2026-09-15T10:11:00.000Z")
        })
      ).resolves.toBe(false);
      await expect(
        resetStore.resetPassword({
          recoveryTokenHash: "sha256:unknown-recovery-token-hash",
          passwordHash: "scrypt:unused-password-hash",
          now: resetAt
        })
      ).resolves.toBe(false);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
