import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  LogisticsDeliveryRegistrar,
  RegisterLogisticsDeliveryCommand,
  RegisterLogisticsDeliveryResult
} from "../application/register-logistics-delivery";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegisterLogisticsDeliveryResult }
  | { kind: "CONFLICT" };

type ShipmentRow = {
  id: string;
  status: "REGISTRADA";
};

type ExistingDeliveryRow = {
  id: string;
};

const UNIQUE_VIOLATION = "23505";
const REGISTER_LOGISTICS_DELIVERY_COMMAND = "logistics.register_delivery";

export class PostgresLogisticsDeliveryRegistrar implements LogisticsDeliveryRegistrar {
  constructor(private readonly pool: Pool) {}

  async register(
    input: RegisterLogisticsDeliveryCommand
  ): Promise<RegisterLogisticsDeliveryResult> {
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

      const result = await this.registerInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "logistics_delivery_code_key") {
          return { ok: false, reason: "DUPLICATE_DELIVERY_CODE" };
        }

        if (error.constraint === "logistics_delivery_shipment_id_key") {
          return { ok: false, reason: "DELIVERY_ALREADY_REGISTERED", shipmentId: input.shipmentId };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: RegisterLogisticsDeliveryCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRegisterLogisticsDeliveryCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, REGISTER_LOGISTICS_DELIVERY_COMMAND, input.commandId, requestHash]
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
      [REGISTER_LOGISTICS_DELIVERY_COMMAND, input.commandId]
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
    result: RegisterLogisticsDeliveryResult
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

  private async registerInTransaction(
    client: PoolClient,
    input: RegisterLogisticsDeliveryCommand
  ): Promise<RegisterLogisticsDeliveryResult> {
    const shipment = await client.query<ShipmentRow>(
      `select "id", "status"::text as "status"
         from "logistics_shipment"
        where "id" = $1
        for update`,
      [input.shipmentId]
    );
    const shipmentRow = shipment.rows[0];

    if (shipmentRow === undefined) {
      return { ok: false, reason: "SHIPMENT_NOT_FOUND", shipmentId: input.shipmentId };
    }

    const existingDelivery = await client.query<ExistingDeliveryRow>(
      `select "id"
         from "logistics_delivery"
        where "shipment_id" = $1
        for update`,
      [input.shipmentId]
    );

    if (existingDelivery.rows[0] !== undefined) {
      return { ok: false, reason: "DELIVERY_ALREADY_REGISTERED", shipmentId: input.shipmentId };
    }

    const deliveryId = randomUUID();

    await client.query(
      `insert into "logistics_delivery" (
        "id", "code", "shipment_id", "acceptance_status", "delivered_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [
        deliveryId,
        input.code,
        input.shipmentId,
        input.acceptanceStatus,
        input.deliveredAt,
        input.summary
      ]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.deliveredAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        REGISTER_LOGISTICS_DELIVERY_COMMAND,
        "logistics_delivery",
        deliveryId,
        JSON.stringify({ shipmentId: input.shipmentId, shipmentStatus: shipmentRow.status }),
        JSON.stringify({ acceptanceStatus: input.acceptanceStatus }),
        input.summary,
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        "logistics.delivery_registered",
        "logistics_delivery",
        deliveryId,
        JSON.stringify({
          deliveryId,
          shipmentId: input.shipmentId,
          acceptanceStatus: input.acceptanceStatus,
          deliveredAt: input.deliveredAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      deliveryId,
      shipmentId: input.shipmentId,
      acceptanceStatus: input.acceptanceStatus
    };
  }
}

function hashRegisterLogisticsDeliveryCommand(input: RegisterLogisticsDeliveryCommand): string {
  const payload = {
    code: input.code,
    shipmentId: input.shipmentId,
    acceptanceStatus: input.acceptanceStatus,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegisterLogisticsDeliveryResult {
  if (isRegisterLogisticsDeliveryResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegisterLogisticsDeliveryResult(
  value: unknown
): value is RegisterLogisticsDeliveryResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { deliveryId?: unknown }).deliveryId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
