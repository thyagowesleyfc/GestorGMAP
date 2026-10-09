import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { FinalizeMaterialRequest } from "../../src/modules/requests/application/finalize-material-request";
import { PostgresMaterialRequestFinalizer } from "../../src/modules/requests/infrastructure/postgres-material-request-finalizer";

const execFileAsync = promisify(execFile);

type MaterialRequestStatus = "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("finalize material request", () => {
  it("rejects invalid input before persistence", async () => {
    const useCase = new FinalizeMaterialRequest({
      finalize: async () => {
        throw new Error("finalizer should not be called for invalid input");
      }
    });

    await expect(
      useCase.execute({
        commandId: " ",
        materialRequestId: randomUUID(),
        reason: "Encerramento pela Triagem"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-finaliza-invalid-request",
        materialRequestId: " ",
        reason: "Encerramento pela Triagem"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_MATERIAL_REQUEST_ID" });

    await expect(
      useCase.execute({
        commandId: "cmd-finaliza-invalid-date",
        materialRequestId: randomUUID(),
        finalizedAt: new Date("invalid"),
        reason: "Encerramento pela Triagem"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_FINALIZED_AT" });

    await expect(
      useCase.execute({
        commandId: "cmd-finaliza-invalid-reason",
        materialRequestId: randomUUID(),
        reason: " "
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_REASON" });
  });

  it("finalizes a dispatched request when every shipment has delivery", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client, {
        status: "DESPACHADA",
        version: 3,
        shipmentCount: 2,
        deliveredShipmentIndexes: [0, 1]
      });
      const useCase = new FinalizeMaterialRequest(new PostgresMaterialRequestFinalizer(pool));
      const command = {
        commandId: " cmd-finaliza-solicitacao-001 ",
        materialRequestId: ` ${seed.materialRequestId} `,
        finalizedAt: new Date("2026-09-25T15:00:00.000Z"),
        reason: " Entregas conferidas pela Triagem. ",
        actorUserId: seed.userId,
        teamContext: "TRIAGEM",
        correlationId: " corr-finaliza-solicitacao-001 "
      };

      const first = await useCase.execute(command);
      const retry = await useCase.execute({
        ...command,
        commandId: "cmd-finaliza-solicitacao-001",
        materialRequestId: seed.materialRequestId,
        reason: "Entregas conferidas pela Triagem.",
        correlationId: "corr-finaliza-solicitacao-001"
      });
      const conflict = await useCase.execute({
        ...command,
        commandId: "cmd-finaliza-solicitacao-001",
        materialRequestId: seed.materialRequestId,
        reason: "Outro motivo"
      });

      expect(first).toEqual({
        ok: true,
        materialRequestId: seed.materialRequestId,
        status: "FINALIZADA"
      });
      expect(retry).toEqual(first);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });
      await expectFinalizedMaterialRequest(client, seed.materialRequestId, 4);
      await expectAuditEntries(client, 1);
      await expectIdempotencyRows(client, 1);
      await expectNoAdditionalLogisticsEffects(client, { shipmentCount: 2, deliveryCount: 2 });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
  it("rejects missing request, non-dispatched request and incomplete logistics", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const notDispatched = await seedMaterialRequest(client, {
        status: "ANALISADA",
        version: 2,
        shipmentCount: 0,
        deliveredShipmentIndexes: []
      });
      const noShipment = await seedMaterialRequest(client, {
        status: "DESPACHADA",
        version: 3,
        shipmentCount: 0,
        deliveredShipmentIndexes: []
      });
      const missingDelivery = await seedMaterialRequest(client, {
        status: "DESPACHADA",
        version: 3,
        shipmentCount: 2,
        deliveredShipmentIndexes: [0]
      });
      const useCase = new FinalizeMaterialRequest(new PostgresMaterialRequestFinalizer(pool));

      const missing = await useCase.execute({
        commandId: "cmd-finaliza-inexistente",
        materialRequestId: randomUUID(),
        finalizedAt: new Date("2026-09-25T15:30:00.000Z"),
        reason: "Solicitacao inexistente"
      });
      const wrongStatus = await useCase.execute({
        commandId: "cmd-finaliza-status-invalido",
        materialRequestId: notDispatched.materialRequestId,
        finalizedAt: new Date("2026-09-25T15:30:00.000Z"),
        reason: "Status nao finalizavel"
      });
      const notShipped = await useCase.execute({
        commandId: "cmd-finaliza-sem-expedicao",
        materialRequestId: noShipment.materialRequestId,
        finalizedAt: new Date("2026-09-25T15:30:00.000Z"),
        reason: "Sem expedicao"
      });
      const notDelivered = await useCase.execute({
        commandId: "cmd-finaliza-sem-entrega",
        materialRequestId: missingDelivery.materialRequestId,
        finalizedAt: new Date("2026-09-25T15:30:00.000Z"),
        reason: "Expedicao sem entrega"
      });

      expect(missing).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_FOUND" });
      expect(wrongStatus).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_DISPATCHED" });
      expect(notShipped).toEqual({ ok: false, reason: "MATERIAL_REQUEST_NOT_SHIPPED" });
      expect(notDelivered).toEqual({
        ok: false,
        reason: "SHIPMENT_NOT_DELIVERED",
        shipmentId: missingDelivery.shipmentIds[1]
      });
      await expectAuditEntries(client, 0);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("blocks accepted tombable materials until patrimonial effects are handled", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedMaterialRequest(client, {
        status: "DESPACHADA",
        version: 3,
        shipmentCount: 1,
        deliveredShipmentIndexes: [0],
        tombable: true,
        acceptanceStatus: "TOTAL"
      });
      const useCase = new FinalizeMaterialRequest(new PostgresMaterialRequestFinalizer(pool));

      const result = await useCase.execute({
        commandId: "cmd-finaliza-patrimonio-pendente",
        materialRequestId: seed.materialRequestId,
        finalizedAt: new Date("2026-09-25T16:00:00.000Z"),
        reason: "Material tombavel ainda exige efeito patrimonial"
      });

      expect(result).toEqual({ ok: false, reason: "PATRIMONIAL_EFFECTS_PENDING" });
      await expectMaterialRequestStatus(client, seed.materialRequestId, "DESPACHADA", 3);
      await expectAuditEntries(client, 0);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectFinalizedMaterialRequest(
  client: Client,
  materialRequestId: string,
  expectedVersion: number
): Promise<void> {
  await expectMaterialRequestStatus(client, materialRequestId, "FINALIZADA", expectedVersion);
}

async function expectMaterialRequestStatus(
  client: Client,
  materialRequestId: string,
  expectedStatus: MaterialRequestStatus,
  expectedVersion: number
): Promise<void> {
  const request = await client.query<{ status: string; version: number }>(
    `select "status"::text, "version"
       from "material_request"
      where "id" = $1`,
    [materialRequestId]
  );

  expect(request.rows).toEqual([{ status: expectedStatus, version: expectedVersion }]);
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
      action: expectedCount === 0 ? null : "requests.finalize_material_request",
      object_type: expectedCount === 0 ? null : "material_request"
    }
  ]);
}

async function expectIdempotencyRows(client: Client, expectedCount: number): Promise<void> {
  const idempotencyRows = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "command_idempotency"
      where "command_name" = 'requests.finalize_material_request'`
  );

  expect(idempotencyRows.rows).toEqual([{ count: expectedCount }]);
}

async function expectNoAdditionalLogisticsEffects(
  client: Client,
  input: { shipmentCount: number; deliveryCount: number }
): Promise<void> {
  const effects = await client.query<{ shipments: number; deliveries: number; documents: number }>(
    `select
       (select count(*)::int from "logistics_shipment") as shipments,
       (select count(*)::int from "logistics_delivery") as deliveries,
       (select count(*)::int from "logistics_delivery_document") as documents`
  );

  expect(effects.rows).toEqual([
    { shipments: input.shipmentCount, deliveries: input.deliveryCount, documents: 0 }
  ]);
}

async function seedMaterialRequest(
  client: Client,
  input: {
    status: MaterialRequestStatus;
    version: number;
    shipmentCount: number;
    deliveredShipmentIndexes: number[];
    tombable?: boolean;
    acceptanceStatus?: "TOTAL" | "PARCIAL" | "RECUSADO";
  }
): Promise<{ materialRequestId: string; shipmentIds: string[]; userId: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const entityId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const shipmentIds = Array.from({ length: input.shipmentCount }, () => randomUUID());

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-FIN-${suffix}`, "GRE Finalizacao Solicitacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, `ENT-FIN-${suffix}`, "Escola Finalizacao Solicitacao", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Finalizacao Solicitacao"]
  );
  await client.query(
    `insert into "user_account" ("id", "person_id", "login_identifier", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [userId, personId, `finalizacao.${suffix.toLowerCase()}@gmap.local`]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, `CLF-${suffix}`, "Materiais para finalizacao"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'QUANTITATIVO', $5, $6, current_timestamp)`,
    [
      materialSingularId,
      `MTF-${suffix}`,
      "Material para finalizacao",
      materialClassId,
      input.tombable === true,
      input.tombable === true ? "EQUIPAMENTO" : null
    ]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      materialRequestId,
      `SOL-FIN-${suffix}`,
      entityId,
      input.status,
      "2026-09-25T12:00:00.000Z",
      "Solicitacao para finalizacao",
      input.version
    ]
  );
  await client.query(
    `insert into "material_request_item" (
      "id", "material_request_id", "line_number", "material_singular_id", "requested_quantity", "authorized_quantity", "updated_at"
    ) values ($1, $2, 1, $3, 2, 2, current_timestamp)`,
    [randomUUID(), materialRequestId, materialSingularId]
  );

  for (const [index, shipmentId] of shipmentIds.entries()) {
    await client.query(
      `insert into "logistics_shipment" (
        "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [
        shipmentId,
        `EXP-FIN-${suffix}-${index + 1}`,
        materialRequestId,
        entityId,
        "2026-09-25T13:00:00.000Z",
        "Expedicao para finalizacao"
      ]
    );

    if (input.deliveredShipmentIndexes.includes(index)) {
      await client.query(
        `insert into "logistics_delivery" (
          "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          `ENT-FIN-${suffix}-${index + 1}`,
          shipmentId,
          input.acceptanceStatus ?? "TOTAL",
          "2026-09-25T14:00:00.000Z",
          "Entrega para finalizacao"
        ]
      );
    }
  }

  return { materialRequestId, shipmentIds, userId };
}
