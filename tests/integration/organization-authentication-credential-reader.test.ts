import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, expect, it } from "vitest";

import { PrismaAuthenticationCredentialReader } from "../../src/modules/organization/infrastructure/authentication/prisma-authentication-credential-reader";

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

describe("PrismaAuthenticationCredentialReader", () => {
  it("loads the minimal credential projection for authentication", async () => {
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
          displayName: "Pessoa Autenticacao"
        }
      });
      const user = await prisma.userAccount.create({
        data: {
          personId: person.id,
          loginIdentifier: "pessoa.autenticacao",
          passwordCredential: {
            create: {
              passwordHash: "scrypt:test-hash"
            }
          }
        }
      });
      const reader = new PrismaAuthenticationCredentialReader(prisma);

      const inactivePerson = await prisma.person.create({
        data: {
          displayName: "Pessoa Inativa"
        }
      });
      const inactiveUser = await prisma.userAccount.create({
        data: {
          personId: inactivePerson.id,
          loginIdentifier: "pessoa.inativa",
          status: "INACTIVE",
          passwordCredential: {
            create: {
              passwordHash: "scrypt:inactive-hash"
            }
          }
        }
      });

      await expect(reader.findByLoginIdentifier("  Pessoa.Autenticacao  ")).resolves.toEqual({
        user: {
          id: user.id,
          status: "ACTIVE"
        },
        passwordHash: "scrypt:test-hash"
      });
      await expect(reader.findByLoginIdentifier("pessoa.inativa")).resolves.toEqual({
        user: {
          id: inactiveUser.id,
          status: "INACTIVE"
        },
        passwordHash: "scrypt:inactive-hash"
      });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("returns null when the user has no password credential or does not exist", async () => {
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
          displayName: "Pessoa Sem Credencial"
        }
      });
      await prisma.userAccount.create({
        data: {
          personId: person.id,
          loginIdentifier: "pessoa.sem.credencial"
        }
      });
      const reader = new PrismaAuthenticationCredentialReader(prisma);

      await expect(reader.findByLoginIdentifier("pessoa.sem.credencial")).resolves.toBeNull();
      await expect(reader.findByLoginIdentifier("pessoa.inexistente")).resolves.toBeNull();
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      await postgres.stop();
    }
  });
});
