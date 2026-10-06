import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  LogisticsShipmentRegistrar,
  RegisterLogisticsShipmentCommand,
  RegisterLogisticsShipmentResult
} from "../application/register-logistics-shipment";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegisterLogisticsShipmentResult }
  | { kind: "CONFLICT" };

type MaterialRequestRow = {
  id: string;
  requesting_entity_id: string;
  status: "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";
};

type StockSeparationRow = {
  id: string;
  stock_position_id: string;
  quantity: number;
};

type ShippedQuantityRow = {
  shipped_quantity: number;
};

const UNIQUE_VIOLATION = "23505";
const REGISTER_LOGISTICS_SHIPMENT_COMMAND = "logistics.register_shipment";

export class PostgresLogisticsShipmentRegistrar implements LogisticsShipmentRegistrar {
  constructor(private readonly pool: Pool) {}

  async register(
    input: RegisterLogisticsShipmentCommand
  ): Promise<RegisterLogisticsShipmentResult> {
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
        if (error.constraint === "logistics_shipment_code_key") {
          return { ok: false, reason: "DUPLICATE_SHIPMENT_CODE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: RegisterLogisticsShipmentCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRegisterLogisticsShipmentCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, REGISTER_LOGISTICS_SHIPMENT_COMMAND, input.commandId, requestHash]
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
      [REGISTER_LOGISTICS_SHIPMENT_COMMAND, input.commandId]
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
    result: RegisterLogisticsShipmentResult
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
    input: RegisterLogisticsShipmentCommand
  ): Promise<RegisterLogisticsShipmentResult> {
    const request = await client.query<MaterialRequestRow>(
      `select "id", "requesting_entity_id", "status"::text as "status"
         from "material_request"
        where "id" = $1
        for update`,
      [input.materialRequestId]
    );
    const requestRow = request.rows[0];

    if (requestRow === undefined) {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_FOUND" };
    }

    if (requestRow.status !== "DESPACHADA") {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_DISPATCHED" };
    }

    const itemsForLock = [...input.items].sort((left, right) =>
      left.stockSeparationId.localeCompare(right.stockSeparationId)
    );

    for (const item of itemsForLock) {
      const separation = await client.query<StockSeparationRow>(
        `select "id", "stock_position_id", "quantity"
           from "stock_separation"
          where "id" = $1
            and "stock_position_id" = $2
            and "status" = 'EM_SEPARACAO'
          for update`,
        [item.stockSeparationId, item.stockPositionId]
      );
      const separationRow = separation.rows[0];

      if (separationRow === undefined) {
        return {
          ok: false,
          reason: "STOCK_SEPARATION_NOT_FOUND",
          stockPositionId: item.stockPositionId,
          stockSeparationId: item.stockSeparationId
        };
      }

      const shipped = await client.query<ShippedQuantityRow>(
        `select coalesce(sum("quantity"), 0)::int as "shipped_quantity"
           from "logistics_shipment_item"
          where "stock_separation_id" = $1`,
        [item.stockSeparationId]
      );
      const alreadyShipped = shipped.rows[0]?.shipped_quantity ?? 0;

      if (alreadyShipped + item.quantity > separationRow.quantity) {
        return {
          ok: false,
          reason: "SHIPMENT_QUANTITY_EXCEEDS_SEPARATION",
          stockPositionId: item.stockPositionId,
          stockSeparationId: item.stockSeparationId
        };
      }
    }

    const shipmentId = randomUUID();

    await client.query(
      `insert into "logistics_shipment" (
        "id", "code", "material_request_id", "receiving_entity_id", "shipped_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [
        shipmentId,
        input.code,
        input.materialRequestId,
        requestRow.requesting_entity_id,
        input.shippedAt,
        input.summary
      ]
    );

    for (const [index, item] of input.items.entries()) {
      await client.query(
        `insert into "logistics_shipment_item" (
          "id", "shipment_id", "line_number", "stock_position_id", "stock_separation_id", "quantity", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          shipmentId,
          index + 1,
          item.stockPositionId,
          item.stockSeparationId,
          item.quantity
        ]
      );
    }

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.shippedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        REGISTER_LOGISTICS_SHIPMENT_COMMAND,
        "logistics_shipment",
        shipmentId,
        JSON.stringify({ materialRequestId: input.materialRequestId, status: requestRow.status }),
        JSON.stringify({ status: "REGISTRADA", itemCount: input.items.length }),
        input.summary,
        input.correlationId
      ]
    );

    return {
      ok: true,
      shipmentId,
      materialRequestId: input.materialRequestId,
      status: "REGISTRADA",
      itemCount: input.items.length
    };
  }
}

function hashRegisterLogisticsShipmentCommand(input: RegisterLogisticsShipmentCommand): string {
  const payload = {
    code: input.code,
    materialRequestId: input.materialRequestId,
    items: input.items,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegisterLogisticsShipmentResult {
  if (isRegisterLogisticsShipmentResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegisterLogisticsShipmentResult(
  value: unknown
): value is RegisterLogisticsShipmentResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { shipmentId?: unknown }).shipmentId === "string";
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
