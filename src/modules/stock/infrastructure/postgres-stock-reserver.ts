import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  ReserveStockCommand,
  ReserveStockResult,
  StockReserver
} from "../application/reserve-stock";

type IdempotencyRow = {
  id: string;
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: ReserveStockResult }
  | { kind: "CONFLICT" };

type LockedStockPosition = {
  id: string;
  reserved_quantity: number;
  available_quantity: number;
  version: number;
};

const UNIQUE_VIOLATION = "23505";
const RESERVE_STOCK_COMMAND = "stock.reserve_stock";

export class PostgresStockReserver implements StockReserver {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveStockCommand): Promise<ReserveStockResult> {
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

      const result = await this.reserveInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "stock_reservation_code_key") {
          return { ok: false, reason: "DUPLICATE_RESERVATION_CODE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: ReserveStockCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashReserveStockCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, RESERVE_STOCK_COMMAND, input.commandId, requestHash]
    );

    if (inserted.rows.length === 1) {
      return { kind: "NEW", id: inserted.rows[0].id };
    }

    const existing = await client.query<IdempotencyRow>(
      `select "id", "request_hash", "status", "result_json"
         from "command_idempotency"
        where "command_name" = $1
          and "idempotency_key" = $2
        for update`,
      [RESERVE_STOCK_COMMAND, input.commandId]
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
    result: ReserveStockResult
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

  private async reserveInTransaction(
    client: PoolClient,
    input: ReserveStockCommand
  ): Promise<ReserveStockResult> {
    const stockPosition = await client.query<LockedStockPosition>(
      `select "id", "reserved_quantity", "available_quantity", "version"
         from "stock_position"
        where "id" = $1
        for update`,
      [input.stockPositionId]
    );
    const row = stockPosition.rows[0];

    if (row === undefined) {
      return {
        ok: false,
        reason: "STOCK_POSITION_NOT_FOUND",
        stockPositionId: input.stockPositionId
      };
    }

    if (row.available_quantity < input.quantity) {
      return {
        ok: false,
        reason: "INSUFFICIENT_STOCK_AVAILABLE",
        stockPositionId: input.stockPositionId
      };
    }

    const reservationId = randomUUID();

    await client.query(
      `insert into "stock_reservation" (
        "id", "code", "stock_position_id", "quantity", "reserved_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
      [
        reservationId,
        input.code,
        input.stockPositionId,
        input.quantity,
        input.reservedAt,
        input.summary
      ]
    );

    await client.query(
      `update "stock_position"
          set "reserved_quantity" = "reserved_quantity" + $2,
              "available_quantity" = "available_quantity" - $2,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.stockPositionId, input.quantity]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.reservedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        "stock.reserve_stock",
        "stock_reservation",
        reservationId,
        JSON.stringify({
          stockPositionId: input.stockPositionId,
          reservedQuantity: row.reserved_quantity,
          availableQuantity: row.available_quantity,
          version: row.version
        }),
        JSON.stringify({
          stockPositionId: input.stockPositionId,
          reservedQuantity: row.reserved_quantity + input.quantity,
          availableQuantity: row.available_quantity - input.quantity,
          version: row.version + 1
        }),
        input.summary,
        input.correlationId
      ]
    );

    return { ok: true, reservationId };
  }
}

function hashReserveStockCommand(input: ReserveStockCommand): string {
  const payload = {
    code: input.code,
    stockPositionId: input.stockPositionId,
    quantity: input.quantity,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): ReserveStockResult {
  if (isReserveStockResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isReserveStockResult(value: unknown): value is ReserveStockResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { reservationId?: unknown }).reservationId === "string";
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
