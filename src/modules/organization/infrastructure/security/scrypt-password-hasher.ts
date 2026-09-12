import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { assertPasswordPolicy } from "../../domain/password-policy";

const HASH_ALGORITHM = "scrypt";
const HASH_VERSION = "v1";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(password: string, storedHash: string): Promise<boolean>;
};

function encodeBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      }
    );
  });
}

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    assertPasswordPolicy(password);

    const salt = randomBytes(SALT_LENGTH);
    const key = await deriveKey(password, salt);

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

  async verify(password: string, storedHash: string): Promise<boolean> {
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

    const salt = decodeBase64Url(encodedSalt);
    const expectedKey = decodeBase64Url(encodedKey);
    const actualKey = await deriveKey(password, salt);

    if (actualKey.byteLength !== expectedKey.byteLength) {
      return false;
    }

    return timingSafeEqual(actualKey, expectedKey);
  }
}
