import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { CreateAuthorizedMaterialRequest } from "../../src/modules/requests/application/create-authorized-material-request";
import { PostgresAuthorizedMaterialRequestCreator } from "../../src/modules/requests/infrastructure/postgres-authorized-material-request-creator";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("create authorized material request", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new CreateAuthorizedMaterialRequest({
      create: async () => {
        throw new Error("creator should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: " ",
        code: "SOL-GER-001",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 2, authorizedQuantity: 1 }],
        summary: "Determinacao superior",
        reason: "Prioridade da Gerencia"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-ger-invalid-code",
        code: "sol-ger-001",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 2, authorizedQuantity: 1 }],
        summary: "Determinacao superior",
        reason: "Prioridade da Gerencia"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REQUEST_CODE" });

    await expect(
      useCase.execute({
        commandId: "cmd-ger-invalid-reason",
        code: "SOL-GER-002",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 2, authorizedQuantity: 1 }],
        summary: "Determinacao superior",
        reason: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REASON" });

    await expect(
      useCase.execute({
        commandId: "cmd-ger-excessive",
        code: "SOL-GER-003",
        requestingEntityId: randomUUID(),
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 2, authorizedQuantity: 3 }],
        summary: "Determinacao superior",
        reason: "Prioridade da Gerencia"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED",
      itemLineNumber: 1
    });

    await expect(
      useCase.execute({
        commandId: "cmd-ger-invalid-catalog",
        code: "SOL-GER-004",
        requestingEntityId: randomUUID(),
        items: [
          {
            materialSingularId: randomUUID(),
            materialConfigurationId: randomUUID(),
            requestedQuantity: 2,
            authorizedQuantity: 1
          }
        ],
        summary: "Determinacao superior",
        reason: "Prioridade da Gerencia"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "INVALID_ITEM_CATALOG_REFERENCE",
      itemLineNumber: 1
    });
  });

  it("creates an analyzed request with authorized quantities, references, audit and idempotency", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = new CreateAuthorizedMaterialRequest(
        new PostgresAuthorizedMaterialRequestCreator(pool)
      );
      const command = {
        commandId: " cmd-ger-cria-autorizada-001 ",
        code: " SOL-GER-CMD-001 ",
        requestingEntityId: ` ${seed.entityId} `,
        items: [
          {
            materialSingularId: ` ${seed.materialSingularId} `,
            requestedQuantity: 5,
            authorizedQuantity: 3
          },
          {
            materialConfigurationId: ` ${seed.materialConfigurationId} `,
            requestedQuantity: 2,
            authorizedQuantity: 2
          }
        ],
        references: [
          { system: "SEI" as const, referenceType: " PROCESSO ", identifier: " SEI-GER-001 " }
        ],
        requestedAt: new Date("2026-09-24T13:00:00.000Z"),
        summary: " Determinacao superior da Gerencia. ",
        reason: " Atendimento autorizado pela Gerencia. ",
        registeredByUserId: ` ${seed.userId} `,
        actorUserId: seed.userId,
        teamContext: "GERENCIA_MATERIAIS",
        correlationId: " corr-ger-cria-autorizada-001 "
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute({
        ...command,
        commandId: "cmd-ger-cria-autorizada-001",
        code: "SOL-GER-CMD-001",
        requestingEntityId: seed.entityId,
        registeredByUserId: seed.userId,
        summary: "Determinacao superior da Gerencia.",
        reason: "Atendimento autorizado pela Gerencia.",
        correlationId: "corr-ger-cria-autorizada-001",
        items: [
          {
            materialSingularId: seed.materialSingularId,
            requestedQuantity: 5,
            authorizedQuantity: 3
          },
          {
            materialConfigurationId: seed.materialConfigurationId,
            requestedQuantity: 2,
            authorizedQuantity: 2
          }
        ],
        references: [
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-GER-001" }
        ]
      });
      const conflict = await useCase.execute({
        ...command,
        commandId: "cmd-ger-cria-autorizada-001",
        code: "SOL-GER-CMD-999"
      });

      expect(first).toEqual({
        ok: true,
        materialRequestId: expect.any(String),
        status: "ANALISADA",
        itemCount: 2,
        referenceCount: 1
      });
      expect(retry).toEqual(first);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectAnalyzedRequest(client, {
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

      const seed = await seedDependencies(client);
      const useCase = new CreateAuthorizedMaterialRequest(
        new PostgresAuthorizedMaterialRequestCreator(pool)
      );
      const base = {
        requestingEntityId: seed.entityId,
        items: [
          {
            materialSingularId: seed.materialSingularId,
            requestedQuantity: 2,
            authorizedQuantity: 1
          }
        ],
        requestedAt: new Date("2026-09-24T13:30:00.000Z"),
        summary: "Determinacao superior para rejeicoes",
        reason: "Autorizacao gerencial"
      };

      const created = await useCase.execute({
        ...base,
        commandId: "cmd-ger-duplicada-base",
        code: "SOL-GER-DUP-001",
        references: [{ system: "SEI", referenceType: "PROCESSO", identifier: "SEI-GER-DUP-001" }]
      });
      const duplicateCode = await useCase.execute({
        ...base,
        commandId: "cmd-ger-duplicada-code",
        code: "SOL-GER-DUP-001"
      });
      const duplicateReferenceInInput = await useCase.execute({
        ...base,
        commandId: "cmd-ger-duplicada-ref-input",
        code: "SOL-GER-DUP-002",
        references: [
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-GER-DUP-LOCAL" },
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-GER-DUP-LOCAL" }
        ]
      });
      const duplicateReferenceInDatabase = await useCase.execute({
        ...base,
        commandId: "cmd-ger-duplicada-ref-db",
        code: "SOL-GER-DUP-003",
        references: [
          { system: "SEI" as const, referenceType: "PROCESSO", identifier: "SEI-GER-DUP-001" }
        ]
      });
      const missingEntity = await useCase.execute({
        ...base,
        commandId: "cmd-ger-entidade-inexistente",
        code: "SOL-GER-DUP-004",
        requestingEntityId: randomUUID()
      });
      const missingUser = await useCase.execute({
        ...base,
        commandId: "cmd-ger-usuario-inexistente",
        code: "SOL-GER-DUP-005",
        registeredByUserId: randomUUID()
      });
      const missingMaterial = await useCase.execute({
        ...base,
        commandId: "cmd-ger-material-inexistente",
        code: "SOL-GER-DUP-006",
        items: [{ materialSingularId: randomUUID(), requestedQuantity: 2, authorizedQuantity: 1 }]
      });

      expect(created).toEqual({
        ok: true,
        materialRequestId: expect.any(String),
        status: "ANALISADA",
        itemCount: 1,
        referenceCount: 1
      });
      expect(duplicateCode).toEqual({ ok: false, reason: "DUPLICATE_REQUEST_CODE" });
      expect(duplicateReferenceInInput).toEqual({
        ok: false,
        reason: "DUPLICATE_REFERENCE",
        referenceIdentifier: "SEI-GER-DUP-LOCAL"
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

async function expectAnalyzedRequest(
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
  }>(
    `select "system"::text,
            "reference_type",
            "identifier"
       from "material_request_reference"
      where "material_request_id" = $1`,
    [input.materialRequestId]
  );

  expect(request.rows).toEqual([
    {
      code: "SOL-GER-CMD-001",
      requesting_entity_id: input.entityId,
      status: "ANALISADA",
      requested_at: "2026-09-24 10:00:00",
      summary: "Determinacao superior da Gerencia.",
      registered_by_user_id: input.userId,
      version: 2
    }
  ]);
  expect(items.rows).toEqual([
    {
      line_number: 1,
      material_singular_id: input.materialSingularId,
      material_configuration_id: null,
      requested_quantity: 5,
      authorized_quantity: 3
    },
    {
      line_number: 2,
      material_singular_id: null,
      material_configuration_id: input.materialConfigurationId,
      requested_quantity: 2,
      authorized_quantity: 2
    }
  ]);
  expect(references.rows).toEqual([
    { system: "SEI", reference_type: "PROCESSO", identifier: "SEI-GER-001" }
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
      action: expectedCount === 0 ? null : "requests.create_authorized_material_request",
      object_type: expectedCount === 0 ? null : "material_request"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'requests.create_authorized_material_request'`
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

async function seedDependencies(client: Client): Promise<{
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
    [greId, `GRE-GER-${suffix}`, "GRE Determinacao Superior"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, `ENT-GER-${suffix}`, "Escola Determinacao Superior", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Determinacao Superior"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [userId, personId, `determinacao.superior.${suffix.toLowerCase()}@gmap.local`]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLG-${suffix}`, "Materiais de determinacao superior"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [
      materialSingularId,
      `MTG-${suffix}`,
      "Monitor para determinacao",
      materialClassId,
      "EQUIPAMENTO"
    ]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, $2, $3, 'KIT', current_timestamp)`,
    [materialConfigurationId, `KIG-${suffix}`, "Kit para determinacao"]
  );

  return { entityId, userId, materialSingularId, materialConfigurationId };
}
