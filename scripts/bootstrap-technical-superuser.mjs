import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";

const HASH_ALGORITHM = "scrypt";
const HASH_VERSION = "v1";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const deriveKey = promisify(scrypt);

export function normalizeLoginIdentifier(loginIdentifier) {
  return loginIdentifier.trim().toLowerCase();
}

export function readBootstrapConfig(env = process.env) {
  const loginIdentifier = normalizeLoginIdentifier(env.GMAP_BOOTSTRAP_SUPERUSER_LOGIN ?? "");
  const displayName = (env.GMAP_BOOTSTRAP_SUPERUSER_NAME ?? "").trim();
  const password = env.GMAP_BOOTSTRAP_SUPERUSER_PASSWORD ?? "";
  const missing = [];

  if (loginIdentifier.length === 0) {
    missing.push("GMAP_BOOTSTRAP_SUPERUSER_LOGIN");
  }

  if (displayName.length === 0) {
    missing.push("GMAP_BOOTSTRAP_SUPERUSER_NAME");
  }

  if (password.length === 0) {
    missing.push("GMAP_BOOTSTRAP_SUPERUSER_PASSWORD");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required bootstrap environment variables: ${missing.join(", ")}`);
  }

  return {
    displayName,
    loginIdentifier,
    password
  };
}

export function assertBootstrapPasswordPolicy(password) {
  const violations = [];

  if (password.length < 12) {
    violations.push("TOO_SHORT");
  }

  if (!/[A-Za-z]/.test(password)) {
    violations.push("MISSING_LETTER");
  }

  if (!/[0-9]/.test(password)) {
    violations.push("MISSING_NUMBER");
  }

  if (violations.length > 0) {
    throw new Error(`Password does not satisfy policy: ${violations.join(",")}`);
  }
}

function encodeBase64Url(buffer) {
  return buffer.toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

export async function hashPassword(password) {
  assertBootstrapPasswordPolicy(password);

  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION
  });

  return [
    HASH_ALGORITHM,
    HASH_VERSION,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    encodeBase64Url(salt),
    encodeBase64Url(key)
  ].join("$");
}

export async function verifyPassword(password, storedHash) {
  const parts = storedHash.split("$");

  if (parts.length !== 7) {
    return false;
  }

  const [algorithm, version, cost, blockSize, parallelization, encodedSalt, encodedKey] = parts;

  if (
    algorithm !== HASH_ALGORITHM ||
    version !== HASH_VERSION ||
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION
  ) {
    return false;
  }

  const expectedKey = decodeBase64Url(encodedKey);
  const actualKey = await deriveKey(password, decodeBase64Url(encodedSalt), KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION
  });

  if (actualKey.byteLength !== expectedKey.byteLength) {
    return false;
  }

  return timingSafeEqual(actualKey, expectedKey);
}

export async function bootstrapTechnicalSuperuser({
  config,
  now = () => new Date(),
  passwordHasher = hashPassword,
  prisma
}) {
  const loginIdentifier = normalizeLoginIdentifier(config.loginIdentifier);

  return prisma.$transaction(async (tx) => {
    const existingUser = await tx.userAccount.findUnique({
      where: { loginIdentifier },
      select: {
        id: true,
        isTechnicalSuperuser: true,
        passwordCredential: { select: { id: true } },
        status: true
      }
    });

    if (existingUser !== null) {
      if (existingUser.status !== "ACTIVE") {
        throw new Error(
          "Usu\u00e1rio de bootstrap existente est\u00e1 inativo; reative manualmente antes de executar o bootstrap."
        );
      }

      if (!existingUser.isTechnicalSuperuser) {
        throw new Error(
          "Login de bootstrap j\u00e1 existe para usu\u00e1rio que n\u00e3o \u00e9 superusu\u00e1rio t\u00e9cnico; escolha outro login ou ajuste manualmente."
        );
      }

      if (existingUser.passwordCredential === null) {
        await tx.passwordCredential.create({
          data: {
            userId: existingUser.id,
            passwordHash: await passwordHasher(config.password),
            passwordUpdatedAt: now()
          }
        });

        return {
          action: "credential_created",
          loginIdentifier,
          userId: existingUser.id
        };
      }

      return {
        action: "unchanged",
        loginIdentifier,
        userId: existingUser.id
      };
    }

    const passwordHash = await passwordHasher(config.password);
    const person = await tx.person.create({
      data: {
        displayName: config.displayName,
        users: {
          create: {
            loginIdentifier,
            status: "ACTIVE",
            isTechnicalSuperuser: true,
            passwordCredential: {
              create: {
                passwordHash,
                passwordUpdatedAt: now()
              }
            }
          }
        }
      },
      select: {
        users: {
          select: {
            id: true,
            loginIdentifier: true
          }
        }
      }
    });

    return {
      action: "created",
      loginIdentifier: person.users[0].loginIdentifier,
      userId: person.users[0].id
    };
  });
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const result = await bootstrapTechnicalSuperuser({
      config: readBootstrapConfig(),
      prisma
    });

    console.log(`Superusu\u00e1rio t\u00e9cnico ${result.action}: ${result.loginIdentifier}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
