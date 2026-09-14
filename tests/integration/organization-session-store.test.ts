import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaSessionStore } from "../../src/modules/organization/infrastructure/session/prisma-session-store";
import { hashSessionToken } from "../../src/modules/organization/infrastructure/session/session-token";

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

describe("PrismaSessionStore", () => {
  it("stores only token hashes and manages active sessions", async () => {
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
          displayName: "Pessoa Teste"
        }
      });
      const user = await prisma.userAccount.create({
        data: {
          personId: person.id
        }
      });
      const store = new PrismaSessionStore(prisma);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      const revocationTime = new Date(now.getTime() + 5000);

      const first = await store.create({
        userId: user.id,
        expiresAt,
        userAgent: "Playwright",
        ipAddress: "127.0.0.1",
        now
      });
      const second = await store.create({
        userId: user.id,
        expiresAt,
        now: new Date(now.getTime() + 1000)
      });

      expect(first.token).not.toEqual(second.token);
      expect(first.session).not.toHaveProperty("sessionTokenHash");

      const persistedFirst = await prisma.userSession.findUniqueOrThrow({
        where: {
          id: first.session.id
        }
      });

      expect(persistedFirst.sessionTokenHash).toBe(hashSessionToken(first.token));
      expect(persistedFirst.sessionTokenHash).not.toBe(first.token);

      await prisma.userSession.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          sessionTokenHash: "sha256:revoked-token-hash",
          expiresAt,
          revokedAt: revocationTime
        }
      });

      await expect(store.findActiveByToken(first.token, now)).resolves.toMatchObject({
        id: first.session.id,
        userId: user.id
      });

      await expect(store.listActiveForUser(user.id, now)).resolves.toEqual([
        expect.objectContaining({ id: second.session.id }),
        expect.objectContaining({ id: first.session.id })
      ]);

      await expect(store.revokeByToken(first.token, revocationTime)).resolves.toBe(1);
      await expect(store.findActiveByToken(first.token, now)).resolves.toBeNull();
      await expect(
        store.findActiveByToken(second.token, new Date(expiresAt.getTime() + 1))
      ).resolves.toBeNull();
      await expect(store.revokeById(second.session.id, revocationTime)).resolves.toBe(1);
      await expect(store.listActiveForUser(user.id, now)).resolves.toEqual([]);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
