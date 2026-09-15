import { describe, expect, it } from "vitest";

import {
  assertBootstrapPasswordPolicy,
  bootstrapTechnicalSuperuser,
  hashPassword,
  readBootstrapConfig,
  verifyPassword
} from "../../../scripts/bootstrap-technical-superuser.mjs";

function createPrismaDouble() {
  const db = {
    nextPersonId: 1,
    nextUserId: 1,
    passwordCredentials: new Map(),
    people: new Map(),
    users: new Map()
  };

  const tx = {
    passwordCredential: {
      async create({ data }) {
        db.passwordCredentials.set(data.userId, { ...data });
        return data;
      }
    },
    person: {
      async create({ data }) {
        const person = {
          id: `person-${db.nextPersonId++}`,
          displayName: data.displayName
        };
        const user = {
          id: `user-${db.nextUserId++}`,
          isTechnicalSuperuser: data.users.create.isTechnicalSuperuser,
          loginIdentifier: data.users.create.loginIdentifier,
          personId: person.id,
          status: data.users.create.status
        };
        db.people.set(person.id, person);
        db.users.set(user.loginIdentifier, user);
        db.passwordCredentials.set(user.id, {
          userId: user.id,
          ...data.users.create.passwordCredential.create
        });
        return { users: [{ id: user.id, loginIdentifier: user.loginIdentifier }] };
      }
    },
    userAccount: {
      async findUnique({ where }) {
        const user = db.users.get(where.loginIdentifier);

        if (user === undefined) {
          return null;
        }

        return {
          id: user.id,
          isTechnicalSuperuser: user.isTechnicalSuperuser,
          passwordCredential: db.passwordCredentials.has(user.id)
            ? { id: `credential-${user.id}` }
            : null,
          status: user.status
        };
      }
    }
  };

  return {
    db,
    prisma: {
      async $transaction(callback) {
        return callback(tx);
      }
    }
  };
}

describe("bootstrap technical superuser script", () => {
  it("reads required configuration from environment variables", () => {
    expect(
      readBootstrapConfig({
        GMAP_BOOTSTRAP_SUPERUSER_LOGIN: "  Admin.GMAP  ",
        GMAP_BOOTSTRAP_SUPERUSER_NAME: " Administrador Tecnico ",
        GMAP_BOOTSTRAP_SUPERUSER_PASSWORD: "SenhaForte123"
      })
    ).toEqual({
      displayName: "Administrador Tecnico",
      loginIdentifier: "admin.gmap",
      password: "SenhaForte123"
    });
  });

  it("requires explicit bootstrap credentials", () => {
    expect(() => readBootstrapConfig({})).toThrow(
      "GMAP_BOOTSTRAP_SUPERUSER_LOGIN, GMAP_BOOTSTRAP_SUPERUSER_NAME, GMAP_BOOTSTRAP_SUPERUSER_PASSWORD"
    );
  });

  it("uses the same scrypt hash format accepted by authentication", async () => {
    const storedHash = await hashPassword("SenhaForte123");

    expect(storedHash).toMatch(/^scrypt\$v1\$16384\$8\$1\$/);
    await expect(verifyPassword("SenhaForte123", storedHash)).resolves.toBe(true);
    await expect(verifyPassword("SenhaErrada123", storedHash)).resolves.toBe(false);
  });

  it("rejects weak bootstrap passwords", () => {
    expect(() => assertBootstrapPasswordPolicy("fraca")).toThrow(
      "Password does not satisfy policy: TOO_SHORT,MISSING_NUMBER"
    );
  });

  it("creates the technical superuser and keeps reruns unchanged", async () => {
    const { db, prisma } = createPrismaDouble();
    let hashCalls = 0;

    const created = await bootstrapTechnicalSuperuser({
      config: {
        displayName: "Administrador Tecnico",
        loginIdentifier: "Admin.GMAP",
        password: "SenhaForte123"
      },
      passwordHasher: async () => {
        hashCalls += 1;
        return "scrypt:first";
      },
      prisma
    });
    const unchanged = await bootstrapTechnicalSuperuser({
      config: {
        displayName: "Outro Nome Ignorado",
        loginIdentifier: "admin.gmap",
        password: "NovaSenha123"
      },
      passwordHasher: async () => {
        hashCalls += 1;
        return "scrypt:second";
      },
      prisma
    });

    expect(created).toEqual({
      action: "created",
      loginIdentifier: "admin.gmap",
      userId: "user-1"
    });
    expect(unchanged).toEqual({
      action: "unchanged",
      loginIdentifier: "admin.gmap",
      userId: "user-1"
    });
    expect(hashCalls).toBe(1);
    expect(db.users.size).toBe(1);
    expect(db.people.get("person-1")).toMatchObject({ displayName: "Administrador Tecnico" });
    expect(db.passwordCredentials.get("user-1")).toMatchObject({ passwordHash: "scrypt:first" });
  });

  it("creates a missing credential for an existing active technical superuser", async () => {
    const { db, prisma } = createPrismaDouble();
    db.people.set("person-1", { id: "person-1", displayName: "Administrador Tecnico" });
    db.users.set("admin.gmap", {
      id: "user-1",
      isTechnicalSuperuser: true,
      loginIdentifier: "admin.gmap",
      personId: "person-1",
      status: "ACTIVE"
    });

    const result = await bootstrapTechnicalSuperuser({
      config: {
        displayName: "Administrador Tecnico",
        loginIdentifier: "admin.gmap",
        password: "SenhaForte123"
      },
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      passwordHasher: async () => "scrypt:created",
      prisma
    });

    expect(result).toEqual({
      action: "credential_created",
      loginIdentifier: "admin.gmap",
      userId: "user-1"
    });
    expect(db.passwordCredentials.get("user-1")).toMatchObject({
      passwordHash: "scrypt:created",
      passwordUpdatedAt: new Date("2026-09-14T12:00:00.000Z")
    });
  });

  it("does not reactivate inactive users or convert regular users", async () => {
    const inactive = createPrismaDouble();
    inactive.db.users.set("admin.gmap", {
      id: "user-1",
      isTechnicalSuperuser: true,
      loginIdentifier: "admin.gmap",
      personId: "person-1",
      status: "INACTIVE"
    });

    await expect(
      bootstrapTechnicalSuperuser({
        config: {
          displayName: "Administrador Tecnico",
          loginIdentifier: "admin.gmap",
          password: "SenhaForte123"
        },
        passwordHasher: async () => "scrypt:unused",
        prisma: inactive.prisma
      })
    ).rejects.toThrow("Usu\u00e1rio de bootstrap existente est\u00e1 inativo");

    const regular = createPrismaDouble();
    regular.db.users.set("admin.gmap", {
      id: "user-1",
      isTechnicalSuperuser: false,
      loginIdentifier: "admin.gmap",
      personId: "person-1",
      status: "ACTIVE"
    });

    await expect(
      bootstrapTechnicalSuperuser({
        config: {
          displayName: "Administrador Tecnico",
          loginIdentifier: "admin.gmap",
          password: "SenhaForte123"
        },
        passwordHasher: async () => "scrypt:unused",
        prisma: regular.prisma
      })
    ).rejects.toThrow("n\u00e3o \u00e9 superusu\u00e1rio t\u00e9cnico");
  });
});
