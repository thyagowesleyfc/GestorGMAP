import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { allocateTomboSequenceInTransaction } from "./postgres-tombo-sequence-allocator";
import type { AllocateTomboSequenceCommand } from "../application/allocate-tombo-sequence";
import type {
  IncorporatePatrimonyFromDeliveryCommand,
  IncorporatePatrimonyFromDeliveryResult,
  PatrimonyIncorporator
} from "../application/incorporate-patrimony-from-delivery";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: IncorporatePatrimonyFromDeliveryResult }
  | { kind: "CONFLICT" };

type DeliveryRow = {
  id: string;
  shipment_id: string;
  acceptance_status: "TOTAL" | "PARCIAL" | "RECUSADO";
  responsible_entity_id: string;
  gre_code: string;
};

type ShipmentItemRow = {
  id: string;
  quantity: number;
  material_singular_id: string | null;
  material_configuration_id: string | null;
  is_tombable: boolean | null;
  patrimonial_group_code: string | null;
};

type ExistingPatrimonyRow = {
  count: number;
};

const INCORPORATE_PATRIMONY_COMMAND = "patrimony.incorporate_from_delivery";
const PATRIMONY_INCORPORATED_EVENT = "patrimony.incorporated";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyIncorporator implements PatrimonyIncorporator {
  constructor(private readonly pool: Pool) {}

  async incorporate(
    input: IncorporatePatrimonyFromDeliveryCommand
  ): Promise<IncorporatePatrimonyFromDeliveryResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const reservation = await this.reserveIdempotency(client, input);
      if (reservation.kind === "REPLAY") {
        await client.query("commit");
        return reservation.result;
      }

      if (reservation.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" };
      }

      const result = await this.incorporateInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: IncorporatePatrimonyFromDeliveryCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashIncorporatePatrimonyCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, INCORPORATE_PATRIMONY_COMMAND, input.commandId, requestHash]
    );

    if (inserted.rows.length === 1) {
      return { kind: "NEW", id: inserted.rows[0].id };
    }

    const existing = await client.query<IdempotencyRow>(
      `select "request_hash", "status", "result_json"
         from "command_idempotency"
        where "command_name" = $1
          and "idempotency_key" = $2
        for update`,
      [INCORPORATE_PATRIMONY_COMMAND, input.commandId]
    );
    const row = existing.rows[0];

    if (row === undefined || row.request_hash !== requestHash) {
      return { kind: "CONFLICT" };
    }

    if (row.status === "SUCCEEDED" && row.result_json !== null) {
      return { kind: "REPLAY", result: parseStoredResult(row.result_json) };
    }

    return { kind: "CONFLICT" };
  }

  private async storeIdempotencyResult(
    client: PoolClient,
    idempotencyId: string,
    result: IncorporatePatrimonyFromDeliveryResult
  ): Promise<void> {
    await client.query(
      `update "command_idempotency"
          set "status" = 'SUCCEEDED',
              "result_json" = $2::jsonb,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [idempotencyId, JSON.stringify(result)]
    );
  }

  private async incorporateInTransaction(
    client: PoolClient,
    input: IncorporatePatrimonyFromDeliveryCommand
  ): Promise<IncorporatePatrimonyFromDeliveryResult> {
    const delivery = await client.query<DeliveryRow>(
      `select d."id",
              d."shipment_id",
              d."acceptance_status"::text as "acceptance_status",
              s."receiving_entity_id" as "responsible_entity_id",
              g."code" as "gre_code"
         from "logistics_delivery" d
         join "logistics_shipment" s on s."id" = d."shipment_id"
         join "entity" e on e."id" = s."receiving_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where d."id" = $1
        for update of d, s`,
      [input.deliveryId]
    );
    const deliveryRow = delivery.rows[0];

    if (deliveryRow === undefined) {
      return { ok: false, reason: "DELIVERY_NOT_FOUND", deliveryId: input.deliveryId };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, deliveryRow.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", deliveryId: input.deliveryId };
    }

    if (deliveryRow.acceptance_status === "RECUSADO") {
      return { ok: false, reason: "DELIVERY_NOT_ACCEPTED", deliveryId: input.deliveryId };
    }

    if (deliveryRow.acceptance_status === "PARCIAL") {
      return {
        ok: false,
        reason: "PARTIAL_ACCEPTANCE_NOT_SUPPORTED",
        deliveryId: input.deliveryId
      };
    }

    const items = await client.query<ShipmentItemRow>(
      `select si."id",
              si."quantity",
              sp."material_singular_id",
              sp."material_configuration_id",
              ms."is_tombable",
              ms."patrimonial_group_code"
         from "logistics_shipment_item" si
         join "stock_position" sp on sp."id" = si."stock_position_id"
         left join "material_singular" ms on ms."id" = sp."material_singular_id"
        where si."shipment_id" = $1
        order by si."line_number"
        for update of si, sp`,
      [deliveryRow.shipment_id]
    );

    if (items.rows.length === 0) {
      return { ok: false, reason: "SHIPMENT_WITHOUT_ITEMS", deliveryId: input.deliveryId };
    }

    if (items.rows.some((item) => item.material_configuration_id !== null)) {
      return {
        ok: false,
        reason: "MATERIAL_CONFIGURATION_UNSUPPORTED",
        deliveryId: input.deliveryId
      };
    }

    if (items.rows.some((item) => item.material_singular_id === null)) {
      return { ok: false, reason: "MATERIAL_NOT_RESOLVED", deliveryId: input.deliveryId };
    }

    if (items.rows.some((item) => item.quantity <= 0)) {
      return {
        ok: false,
        reason: "INVALID_SHIPMENT_ITEM_QUANTITY",
        deliveryId: input.deliveryId
      };
    }

    const tombableItems = items.rows.filter((item) => item.is_tombable === true);

    if (tombableItems.length === 0) {
      return { ok: false, reason: "NO_TOMBABLE_ITEMS", deliveryId: input.deliveryId };
    }

    for (const item of tombableItems) {
      if (item.patrimonial_group_code === null || !/^\d{2}$/.test(item.patrimonial_group_code)) {
        return {
          ok: false,
          reason: "MATERIAL_PATRIMONIAL_GROUP_INVALID",
          deliveryId: input.deliveryId,
          shipmentItemId: item.id
        };
      }

      const existing = await client.query<ExistingPatrimonyRow>(
        `select count(*)::int as "count"
           from "patrimony"
          where "source_delivery_id" = $1
            and "source_shipment_item_id" = $2`,
        [input.deliveryId, item.id]
      );

      if ((existing.rows[0]?.count ?? 0) > 0) {
        return {
          ok: false,
          reason: "PATRIMONY_ALREADY_INCORPORATED",
          deliveryId: input.deliveryId,
          shipmentItemId: item.id
        };
      }
    }

    const patrimonyIds: string[] = [];
    const tombos: string[] = [];

    for (const item of tombableItems) {
      const sequenceInput: AllocateTomboSequenceCommand = {
        patrimonialGroupCode: item.patrimonial_group_code as string
      };

      for (let unit = 0; unit < item.quantity; unit += 1) {
        const patrimonyId = randomUUID();
        const allocation = await allocateTomboSequenceInTransaction(client, sequenceInput);

        await client.query(
          `insert into "patrimony" (
            "id", "material_singular_id", "responsible_entity_id",
            "source_delivery_id", "source_shipment_item_id", "incorporated_at", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [
            patrimonyId,
            item.material_singular_id,
            deliveryRow.responsible_entity_id,
            input.deliveryId,
            item.id,
            input.incorporatedAt
          ]
        );

        await client.query(
          `insert into "patrimony_tombo" (
            "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
          ) values ($1, $2, $3, $4, $5, current_timestamp)`,
          [
            randomUUID(),
            patrimonyId,
            allocation.tombo,
            allocation.patrimonialGroupCode,
            input.incorporatedAt
          ]
        );

        await client.query(
          `insert into "audit_entry" (
            "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
            "previous_value", "next_value", "reason", "correlation_id"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
          [
            randomUUID(),
            input.incorporatedAt,
            input.actorUserId,
            input.teamContext,
            INCORPORATE_PATRIMONY_COMMAND,
            "patrimony",
            patrimonyId,
            null,
            JSON.stringify({
              materialSingularId: item.material_singular_id,
              responsibleEntityId: deliveryRow.responsible_entity_id,
              sourceDeliveryId: input.deliveryId,
              sourceShipmentItemId: item.id,
              tombo: allocation.tombo
            }),
            input.reason,
            input.correlationId
          ]
        );

        await client.query(
          `insert into "outbox_event" (
            "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
          ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
          [
            randomUUID(),
            PATRIMONY_INCORPORATED_EVENT,
            "patrimony",
            patrimonyId,
            JSON.stringify({
              patrimonyId,
              deliveryId: input.deliveryId,
              shipmentItemId: item.id,
              materialSingularId: item.material_singular_id,
              responsibleEntityId: deliveryRow.responsible_entity_id,
              tombo: allocation.tombo,
              incorporatedAt: input.incorporatedAt.toISOString(),
              correlationId: input.correlationId
            })
          ]
        );

        patrimonyIds.push(patrimonyId);
        tombos.push(allocation.tombo);
      }
    }

    return { ok: true, deliveryId: input.deliveryId, patrimonyIds, tombos };
  }

  private async isAuthorized(client: PoolClient, actorUserId: string, greCode: string) {
    const authorization = await client.query<{ authorized: boolean }>(
      `select exists(
         select 1
           from "user_account" u
           join "team_membership" tm on tm."user_id" = u."id"
           join "team" t on t."id" = tm."team_id"
          where u."id" = $1
            and u."status" = 'ACTIVE'
            and tm."active" = true
            and t."name" = any($2::varchar[])
            and (tm."scope_type" = 'GLOBAL' or (tm."scope_type" = 'GRE' and tm."gre_code" = $3))
       ) as "authorized"`,
      [actorUserId, AUTHORIZED_TEAM_NAMES, greCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashIncorporatePatrimonyCommand(input: IncorporatePatrimonyFromDeliveryCommand): string {
  const payload = {
    deliveryId: input.deliveryId,
    reason: input.reason,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): IncorporatePatrimonyFromDeliveryResult {
  if (isIncorporatePatrimonyFromDeliveryResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isIncorporatePatrimonyFromDeliveryResult(
  value: unknown
): value is IncorporatePatrimonyFromDeliveryResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { deliveryId?: unknown }).deliveryId === "string" &&
      Array.isArray((value as { patrimonyIds?: unknown }).patrimonyIds) &&
      Array.isArray((value as { tombos?: unknown }).tombos)
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
