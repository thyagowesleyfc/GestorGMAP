import { describe, expect, it } from "vitest";

import { ScryptPasswordHasher } from "../../../src/modules/organization/infrastructure/security/scrypt-password-hasher";

describe("scrypt password hasher", () => {
  it("hashes and verifies a valid password", async () => {
    const hasher = new ScryptPasswordHasher();

    const storedHash = await hasher.hash("SenhaForte123");

    expect(storedHash).toMatch(/^scrypt\$v1\$16384\$8\$1\$/);
    await expect(hasher.verify("SenhaForte123", storedHash)).resolves.toBe(true);
    await expect(hasher.verify("SenhaErrada123", storedHash)).resolves.toBe(false);
  });

  it("uses a different salt for each hash", async () => {
    const hasher = new ScryptPasswordHasher();

    await expect(hasher.hash("SenhaForte123")).resolves.not.toBe(
      await hasher.hash("SenhaForte123")
    );
  });

  it("rejects weak passwords before hashing", async () => {
    const hasher = new ScryptPasswordHasher();

    await expect(hasher.hash("fraca")).rejects.toThrow("Password does not satisfy policy");
  });

  it("does not verify unsupported or malformed hashes", async () => {
    const hasher = new ScryptPasswordHasher();

    await expect(hasher.verify("SenhaForte123", "argon2id$v=19$hash")).resolves.toBe(false);
    await expect(
      hasher.verify("SenhaForte123", "scrypt$v1$16384$8$1$not-base64$url")
    ).resolves.toBe(false);
  });
});
