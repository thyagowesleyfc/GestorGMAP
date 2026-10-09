import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterMaterialRequest } from "../../src/modules/requests/application/register-material-request";
import { PostgresMaterialRequestRegistrar } from "../../src/modules/requests/infrastructure/postgres-material-request-registrar";

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

describe("register material request", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new RegisterMaterialRequest({
      register: async () => {
        throw new Error("registrar should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: "  ",
        code: "SOL-INVALID-001",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 1 }],
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-code",
        code: "sol-invalid-001",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 1 }],
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REQUEST_CODE" });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-date",
        code: "SOL-INVALID-002",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 1 }],
        requestedAt: new Date("invalid"),
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REQUESTED_AT" });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-summary",
        code: "SOL-INVALID-003",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 1 }],
        summary: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_SUMMARY" });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-items",
        code: "SOL-INVALID-004",
        requestingEntityId: randomUUID(),
        items: [],
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_ITEMS" });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-catalog",
        code: "SOL-INVALID-005",
        requestingEntityId: randomUUID(),
        items: [
          {
            materialSingularId: randomUUID(),
            materialConfigurationId: randomUUID(),
            requestedQuantity: 1
          }
        ],
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "INVALID_ITEM_CATALOG_REFERENCE",
      itemLineNumber: 1
    });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-quantity",
        code: "SOL-INVALID-006",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 0 }],
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "INVALID_REQUESTED_QUANTITY",
      itemLineNumber: 1
    });

    await expect(
      useCase.execute({
        commandId: "cmd-invalid-reference",
        code: "SOL-INVALID-007",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 1 }],
        references: [{ system: "SEI", referenceType: "PROCESSO", identifier: " ", url: " " }],
        summary: "Solicitacao valida"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "INVALID_REFERENCE_IDENTIFIER",
      referenceIdentifier: ""
    });
  });

  it("registers a triaged material request with items, references, audit and idempotency", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequestDependencies(client);
      const useCase = new RegisterMaterialRequest(new PostgresMaterialRequestRegistrar(pool));
      const command = {
        commandId: " cmd-registra-solicitacao-001 ",
        code: " SOL-MAT-CMD-001 ",
        requestingEntityId: ` ${seed.entityId} `,
        items: [
          { materialSingularId: ` ${seed.materialSingularId} `, requestedQuantity: 5 },
          { materialConfigurationId: ` ${seed.materialConfigurationId} `, requestedQuantity: 2 }
        ],
        references: [
          {
            system: "SEI" as const,
            referenceType: " PROCESSO ",
            identifier: " 00001.000001/2026-01 ",
            url: " https://sei.example/processo/1 "
          },
          {
            system: "REDMINE" as const,
            referenceType: " TICKET ",
            identifier: " GMAP-123 "
          }
        ],
        requestedAt: new Date("2026-09-24T12:00:00.000Z"),
        summary: " Necessidade registrada pela Triagem. ",
        registeredByUserId: ` ${seed.userId} `,
        actorUserId: seed.userId,
        teamContext: "TRIAGEM",
        correlationId: " corr-registra-solicitacao-001 "
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute({
        ...command,
        commandId: "cmd-registra-solicitacao-001",
        code: "SOL-MAT-CMD-001",
        requestingEntityId: seed.entityId,
        registeredByUserId: seed.userId,
        summary: "Necessidade registrada pela Triagem.",
        correlationId: "corr-registra-solicitacao-001",
        items: [
          { materialSingularId: seed.materialSingularId, requestedQuantity: 5 },
          { materialConfigurationId: seed.materialConfigurationId, requestedQuantity: 2 }
        ],
        references: [
          {
            system: "SEI" as const,
            referenceType: "PROCESSO",
            identifier: "00001.000001/2026-01",
            url: "https://sei.example/processo/1"
          },
          { system: "REDMINE" as const, referenceType: "TICKET", identifier: "GMAP-123" }
        ]
      });
      const conflict = await useCase.execute({
        ...command,
        commandId: "cmd-registra-solicitacao-001",
        code: "SOL-MAT-CMD-999"
      });

      expect(first).toEqual({
        ok: true,
        materialRequestId: expect.any(String),
        status: "TRIAGEM",
        itemCount: 2,
        referenceCount: 2
      });
      expect(retry).toEqual(first);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectRegisteredMaterialRequest(client, {
        materialRequestId: first.ok ? first.materialRequestId : "",
        entityId: seed.entityId,
        userId: seed.userId,
        materialSingularId: seed.materialSingularId,
        materialConfigurationId: seed.materialConfigurationId
      });
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
      await expectNoPhysicalEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
  it("rejects missing dependencies, duplicate code and duplicate references", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequestDependencies(client);
      const useCase = new RegisterMaterialRequest(new PostgresMaterialRequestRegistrar(pool));
      const base = {
        requestingEntityId: seed.entityId,
        items: [{ materialSingularId: seed.materialSingularId, requestedQuantity: 1 }],
        requestedAt: new Date("2026-09-24T12:30:00.000Z"),
        summary: "Solicitacao para rejeicoes controladas"
      };

      const created = await useCase.execute({
        ...base,
        commandId: "cmd-registra-duplicada-base",
        code: "SOL-MAT-DUP-001",
        references: [{ system: "SEI", referenceType: "PROCESSO", identifier: "SEI-DUP-001" }]
      });
      const duplicateCode = await useCase.execute({
        ...base,
        commandId: "cmd-registra-duplicada-code",
        code: "SOL-MAT-DUP-001"
      });
      const duplicateReferenceInInput = await useCase.execute({
        ...base,
        commandId: "cmd-registra-duplicada-ref-input",
        code: "SOL-MAT-DUP-002",
        references: [
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-DUP-LOCAL" },
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-DUP-LOCAL" }
        ]
      });
      const duplicateReferenceInDatabase = await useCase.execute({
        ...base,
        commandId: "cmd-registra-duplicada-ref-db",
        code: "SOL-MAT-DUP-003",
        references: [
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-DUP-001" }
        ]
      });
      const missingEntity = await useCase.execute({
        ...base,
        commandId: "cmd-registra-entidade-inexistente",
        code: "SOL-MAT-DUP-004",
        requestingEntityId: randomUUID()
      });
      const missingUser = await useCase.execute({
        ...base,
        commandId: "cmd-registra-usuario-inexistente",
        code: "SOL-MAT-DUP-005",
        registeredByUserId: randomUUID()
      });
      const missingMaterial = await useCase.execute({
        ...base,
        commandId: "cmd-registra-material-inexistente",
        code: "SOL-MAT-DUP-006",
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 1 }]
      });

      expect(created).toEqual({
        ok: true,
        materialRequestId: expect.any(String),
        status: "TRIAGEM",
        itemCount: 1,
        referenceCount: 1
      });
      expect(duplicateCode).toEqual({ ok: false, reason: "DUPLICATE_REQUEST_CODE" });
      expect(duplicateReferenceInInput).toEqual({
        ok: false,
        reason: "DUPLICATE_REFERENCE",
        referenceIdentifier: "SEI-DUP-LOCAL"
      });
      expect(duplicateReferenceInDatabase).toEqual({ ok: false, reason: "DUPLICATE_REFERENCE" });
      expect(missingEntity).toEqual({ ok: false, reason: "REQUESTING_ENTITY_NOT_FOUND" });
      expect(missingUser).toEqual({ ok: false, reason: "REGISTERED_BY_USER_NOT_FOUND" });
      expect(missingMaterial).toEqual({
        ok: false,
        reason: "MATERIAL_NOT_FOUND",
        itemLineNumber: 1
      });
      await expectMaterialRequestCount(client, 1);
      await expectNoPhysicalEffects(client);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectRegisteredMaterialRequest(
  client: Client,
  input: {
    materialRequestId: string;
    entityId: string;
    userId: string;
    materialSingularId: string;
    materialConfigurationId: string;
  }
): Promise<void> {
  const request = await client.query<{
    code: string;
    requesting_entity_id: string;
    status: string;
    requested_at: string;
    summary: string;
    registered_by_user_id: string | null;
    version: number;
  }>(
    `select "code",
            "requesting_entity_id",
            "status"::text,
            "requested_at"::text,
            "summary",
            "registered_by_user_id",
            "version"
       from "material_request"
      where "id" = $1`,
    [input.materialRequestId]
  );
  const items = await client.query<{
    line_number: number;
    material_singular_id: string | null;
    material_configuration_id: string | null;
    requested_quantity: number;
    authorized_quantity: number | null;
  }>(
    `select "line_number",
            "material_singular_id",
            "material_configuration_id",
            "requested_quantity",
            "authorized_quantity"
       from "material_request_item"
      where "material_request_id" = $1
      order by "line_number"`,
    [input.materialRequestId]
  );
  const references = await client.query<{
    system: string;
    reference_type: string;
    identifier: string;
    url: string | null;
  }>(
    `select "system"::text,
            "reference_type",
            "identifier",
            "url"
       from "material_request_reference"
      where "material_request_id" = $1
      order by "system"`,
    [input.materialRequestId]
  );

  expect(request.rows).toEqual([
    {
      code: "SOL-MAT-CMD-001",
      requesting_entity_id: input.entityId,
      status: "TRIAGEM",
      requested_at: "2026-09-24 09:00:00",
      summary: "Necessidade registrada pela Triagem.",
      registered_by_user_id: input.userId,
      version: 1
    }
  ]);
  expect(items.rows).toEqual([
    {
      line_number: 1,
      material_singular_id: input.materialSingularId,
      material_configuration_id: null,
      requested_quantity: 5,
      authorized_quantity: null
    },
    {
      line_number: 2,
      material_singular_id: null,
      material_configuration_id: input.materialConfigurationId,
      requested_quantity: 2,
      authorized_quantity: null
    }
  ]);
  expect(references.rows).toEqual([
    {
      system: "REDMINE",
      reference_type: "TICKET",
      identifier: "GMAP-123",
      url: null
    },
    {
      system: "SEI",
      reference_type: "PROCESSO",
      identifier: "00001.000001/2026-01",
      url: "https://sei.example/processo/1"
    }
  ]);
}

async function expectAuditEntries(client: Client, expectedCount: number): Promise<void> {
  const auditEntries = await client.query<{
    count: number;
    action: string | null;
    object_type: string | null;
  }>(
    `select count(*)::int as count,
            min("action") as action,
            min("object_type") as object_type
       from "audit_entry"`
  );

  expect(auditEntries.rows).toEqual([
    {
      count: expectedCount,
      action: expectedCount === 0 ? null : "requests.register_material_request",
      object_type: expectedCount === 0 ? null : "material_request"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'requests.register_material_request'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectMaterialRequestCount(client: Client, expectedCount: number): Promise<void> {
  const requests = await client.query<{ count: number }>(
    `select count(*)::int as count from "material_request"`
  );

  expect(requests.rows).toEqual([{ count: expectedCount }]);
}

async function expectNoPhysicalEffects(client: Client): Promise<void> {
  const effects = await client.query<{
    reservations: number;
    separations: number;
    movements: number;
    shipments: number;
    deliveries: number;
  }>(
    `select
       (select count(*)::int from "stock_reservation") as reservations,
       (select count(*)::int from "stock_separation") as separations,
       (select count(*)::int from "stock_movement") as movements,
       (select count(*)::int from "logistics_shipment") as shipments,
       (select count(*)::int from "logistics_delivery") as deliveries`
  );

  expect(effects.rows).toEqual([
    { reservations: 0, separations: 0, movements: 0, shipments: 0, deliveries: 0 }
  ]);
}

async function seedMaterialRequestDependencies(client: Client): Promise<{
  entityId: string;
  userId: string;
  materialSingularId: string;
  materialConfigurationId: string;
}> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const entityId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialConfigurationId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-REG-${suffix}`, "GRE Registro Solicitacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, `ENT-REG-${suffix}`, "Escola Registro Solicitacao", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Registro Solicitacao"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [userId, personId, `solicitacao.registro.${suffix.toLowerCase()}@gmap.local`]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLR-${suffix}`, "Materiais para registro"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, `MTR-${suffix}`, "Monitor para registro", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, $2, $3, 'KIT', current_timestamp)`,
    [materialConfigurationId, `KIT-${suffix}`, "Kit para registro"]
  );

  return { entityId, userId, materialSingularId, materialConfigurationId };
}
