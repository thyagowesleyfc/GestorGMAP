import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaPasswordRecoveryRequestStore } from "../../src/modules/organization/infrastructure/authentication/prisma-password-recovery-request-store";
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
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
