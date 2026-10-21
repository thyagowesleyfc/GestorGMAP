import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { IncorporatePatrimonyFromAcceptedDelivery } from "../../src/modules/patrimony/application/incorporate-patrimony-from-delivery";
import { PostgresPatrimonyIncorporator } from "../../src/modules/patrimony/infrastructure/postgres-patrimony-incorporator";

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

describe("incorporate patrimony from accepted delivery", () => {
  it("authorizes a TOTAL delivery, creates one patrimony per unit, and is idempotent", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedIncorporation(client);
      const useCase = new IncorporatePatrimonyFromAcceptedDelivery(
        new PostgresPatrimonyIncorporator(pool)
      );

      await expect(
        useCase.execute({
          commandId: "cmd-pat-inc-partial",
          deliveryId: seed.deliveryId,
          reason: "Aguardar quantidade aceita",
          actorUserId: seed.authorizedUserId,
          teamContext: "Patrimonio",
          incorporatedAt: new Date("2026-09-25T16:00:00.000Z")
        })
      ).resolves.toEqual({
        ok: false,
        reason: "PARTIAL_ACCEPTANCE_NOT_SUPPORTED",
        deliveryId: seed.deliveryId
      });

      await client.query(
        `update "logistics_delivery"
            set "acceptance_status" = 'TOTAL',
                "updated_at" = current_timestamp
          where "id" = $1`,
        [seed.deliveryId]
      );

      await expect(
        useCase.execute({
          commandId: "cmd-pat-inc-unauthorized",
          deliveryId: seed.deliveryId,
          reason: "Tentativa sem membership",
          actorUserId: seed.technicalUserId,
          teamContext: "Patrimonio"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        deliveryId: seed.deliveryId
      });

      const input = {
        commandId: "cmd-pat-inc-total",
        deliveryId: seed.deliveryId,
        reason: "Incorporacao apos aceite total",
        actorUserId: seed.authorizedUserId,
        teamContext: "Patrimonio",
        incorporatedAt: new Date("2026-09-25T16:00:00.000Z")
      };

      const result = await useCase.execute(input);

      expect(result).toMatchObject({
        ok: true,
        deliveryId: seed.deliveryId,
        tombos: ["011-01-000001", "011-01-000002"]
      });
      expect(result.ok && result.patrimonyIds).toHaveLength(2);

      await expect(useCase.execute(input)).resolves.toEqual(result);

      await expect(
        useCase.execute({
          ...input,
          commandId: "cmd-pat-inc-duplicate"
        })
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_ALREADY_INCORPORATED",
        deliveryId: seed.deliveryId,
        shipmentItemId: seed.shipmentItemId
      });

      const patrimonies = await client.query<{
        id: string;
        source_delivery_id: string;
        source_shipment_item_id: string;
        responsible_entity_id: string;
      }>(
        `select "id", "source_delivery_id", "source_shipment_item_id", "responsible_entity_id"
           from "patrimony"
          where "source_delivery_id" = $1
          order by "id"`,
        [seed.deliveryId]
      );
      expect(patrimonies.rows).toHaveLength(2);
      expect(
        patrimonies.rows.every(
          (row) =>
            row.source_shipment_item_id === seed.shipmentItemId &&
            row.responsible_entity_id === seed.responsibleEntityId
        )
      ).toBe(true);

      const audit = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "audit_entry"
          where "action" = 'patrimony.incorporate_from_delivery'
            and "object_type" = 'patrimony'`,
        []
      );
      expect(audit.rows[0]?.count).toBe(2);

      const outbox = await client.query<{ count: number }>(
        `select count(*)::int as "count"
           from "outbox_event"
          where "event_type" = 'patrimony.incorporated'
            and "aggregate_type" = 'patrimony'`,
        []
      );
      expect(outbox.rows[0]?.count).toBe(2);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type IncorporationSeed = {
  authorizedUserId: string;
  technicalUserId: string;
  deliveryId: string;
  shipmentItemId: string;
  responsibleEntityId: string;
};

async function seedIncorporation(client: Client): Promise<IncorporationSeed> {
  const greId = randomUUID();
  const greCode = "GRE-PAT-INC";
  const responsibleEntityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const materialRequestId = randomUUID();
  const stockPositionId = randomUUID();
  const reservationId = randomUUID();
  const separationId = randomUUID();
  const shipmentId = randomUUID();
  const shipmentItemId = randomUUID();
  const deliveryId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, greCode, "GRE Patrimonio Incorporacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [responsibleEntityId, "ENT-PAT-INC", "Escola Patrimonio Incorporacao", greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "CL-PAT-INC", "Classe Patrimonio Incorporacao"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-PAT-INC", "Material Patrimonial Incorporacao", materialClassId, "01"]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "status", "requested_at", "summary", "updated_at"
    ) values ($1, $2, $3, 'DESPACHADA', $4, $5, current_timestamp)`,
    [
      materialRequestId,
      "SOL-PAT-INC-0001",
      responsibleEntityId,
      "2026-09-24T19:30:00.000Z",
      "Solicitacao para incorporacao patrimonial"
    ]
  );
  await client.query(
    `insert into "stock_position" (
      "id", "stock_entity_id", "material_singular_id", "origin_type",
      "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "updated_at"
    ) values ($1, $2, $3, 'PENDENTE', 2, 0, 0, 2, current_timestamp)`,
    [stockPositionId, responsibleEntityId, materialSingularId]
  );
  await client.query(
    `insert into "stock_reservation" (
      "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
    ) values ($1, $2, $3, 2, $4, $5, current_timestamp)`,
    [
      reservationId,
      "RES-PAT-INC-0001",
      stockPositionId,
      "2026-09-24T20:00:00.000Z",
      "Reserva para incorporacao patrimonial"
    ]
  );
  await client.query(
    `insert into "stock_separation" (
      "id", "code", "stock_position_id", "stock_reservation_id", "quantity", "separated_at",
      "summary", "updated_at"
    ) values ($1, $2, $3, $4, 2, $5, $6, current_timestamp)`,
    [
      separationId,
      "SEP-PAT-INC-0001",
      stockPositionId,
      reservationId,
      "2026-09-24T20:30:00.000Z",
      "Separacao para incorporacao patrimonial"
    ]
  );
  await client.query(
    `insert into "logistics_shipment" (
      "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      shipmentId,
      "EXP-PAT-INC-0001",
      materialRequestId,
      responsibleEntityId,
      "2026-09-24T21:00:00.000Z",
      "Expedicao para incorporacao patrimonial"
    ]
  );
  await client.query(
    `insert into "logistics_shipment_item" (
      "id", "shipment_id", "line_number", "stock_position_id", "stock_separation_id", "quantity", "updated_at"
    ) values ($1, $2, 1, $3, $4, 2, current_timestamp)`,
    [shipmentItemId, shipmentId, stockPositionId, separationId]
  );
  await client.query(
    `insert into "logistics_delivery" (
      "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "updated_at"
    ) values ($1, $2, $3, 'PARCIAL', $4, $5, current_timestamp)`,
    [
      deliveryId,
      "ENT-PAT-INC-0001",
      shipmentId,
      "2026-09-25T16:00:00.000Z",
      "Entrega para incorporacao patrimonial"
    ]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp), ($3, $4, current_timestamp)`,
    [
      authorizedPersonId,
      "Usuario Patrimonio Autorizado",
      technicalPersonId,
      "Superusuario Tecnico Sem Membership"
    ]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
    ) values ($1, $2, $3, false, current_timestamp),
             ($4, $5, $6, true, current_timestamp)`,
    [
      authorizedUserId,
      authorizedPersonId,
      "usuario-patrimonio-incorporacao",
      technicalUserId,
      technicalPersonId,
      "superusuario-tecnico-incorporacao"
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [teamId, "Patrimônio"]
  );
  await client.query(
    `insert into "team_membership" (
      "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
    ) values ($1, $2, $3, 'LIDER', 'GRE', $4, current_timestamp)`,
    [randomUUID(), authorizedUserId, teamId, greCode]
  );

  return {
    authorizedUserId,
    technicalUserId,
    deliveryId,
    shipmentItemId,
    responsibleEntityId
  };
}
