import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  SeparateStockCommand,
  SeparateStockResult,
  StockSeparator
} from "../application/separate-stock";

type IdempotencyRow = {
  id: string;
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencySeparation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: SeparateStockResult }
  | { kind: "CONFLICT" };

type LockedStockPosition = {
  id: string;
  reserved_quantity: number;
  separating_quantity: number;
  available_quantity: number;
  version: number;
};

type LockedStockReservation = {
  id: string;
  quantity: number;
};

type ExistingSeparationQuantity = {
  separated_quantity: number;
};

const UNIQUE_VIOLATION = "23505";
const SEPARATE_STOCK_COMMAND = "stock.separate_stock";

export class PostgresStockSeparator implements StockSeparator {
  constructor(private readonly pool: Pool) {}

  async separate(input: SeparateStockCommand): Promise<SeparateStockResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const separation = await this.reserveIdempotency(client, input);
      if (separation.kind === "REPLAY") {
        await client.query("commit");
        return separation.result;
      }

      if (separation.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" };
      }

      const result = await this.separateInTransaction(client, input);
      await this.storeIdempotencyResult(client, separation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "stock_separation_code_key") {
          return { ok: false, reason: "DUPLICATE_SEPARATION_CODE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: SeparateStockCommand
  ): Promise<IdempotencySeparation> {
    const requestHash = hashSeparateStockCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, SEPARATE_STOCK_COMMAND, input.commandId, requestHash]
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
      [SEPARATE_STOCK_COMMAND, input.commandId]
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
    result: SeparateStockResult
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

  private async separateInTransaction(
    client: PoolClient,
    input: SeparateStockCommand
  ): Promise<SeparateStockResult> {
    const stockPosition = await client.query<LockedStockPosition>(
      `select "id", "reserved_quantity", "separating_quantity", "available_quantity", "version"
         from "stock_position"
        where "id" = $1
        for update`,
      [input.stockPositionId]
    );
    const position = stockPosition.rows[0];

    if (position === undefined) {
      return {
        ok: false,
        reason: "STOCK_POSITION_NOT_FOUND",
        stockPositionId: input.stockPositionId
      };
    }

    const stockReservation = await client.query<LockedStockReservation>(
      `select "id", "quantity"
         from "stock_reservation"
        where "id" = $1
          and "stock_position_id" = $2
          and "status" = 'ATIVA'
        for update`,
      [input.stockReservationId, input.stockPositionId]
    );
    const reservation = stockReservation.rows[0];

    if (reservation === undefined) {
      return {
        ok: false,
        reason: "STOCK_RESERVATION_NOT_FOUND",
        stockPositionId: input.stockPositionId,
        stockReservationId: input.stockReservationId
      };
    }

    const existingSeparation = await client.query<ExistingSeparationQuantity>(
      `select coalesce(sum("quantity"), 0)::int as "separated_quantity"
         from "stock_separation"
        where "stock_reservation_id" = $1`,
      [input.stockReservationId]
    );
    const alreadySeparated = existingSeparation.rows[0]?.separated_quantity ?? 0;

    if (
      position.reserved_quantity < input.quantity ||
      reservation.quantity - alreadySeparated < input.quantity
    ) {
      return {
        ok: false,
        reason: "INSUFFICIENT_RESERVED_STOCK",
        stockPositionId: input.stockPositionId,
        stockReservationId: input.stockReservationId
      };
    }

    const separationId = randomUUID();

    await client.query(
      `insert into "stock_separation" (
        "id", "code", "stock_position_id", "stock_reservation_id",
        "quantity", "separated_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
      [
        separationId,
        input.code,
        input.stockPositionId,
        input.stockReservationId,
        input.quantity,
        input.separatedAt,
        input.summary
      ]
    );

    await client.query(
      `update "stock_position"
          set "reserved_quantity" = "reserved_quantity" - $2,
              "separating_quantity" = "separating_quantity" + $2,
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
        input.separatedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        SEPARATE_STOCK_COMMAND,
        "stock_separation",
        separationId,
        JSON.stringify({
          stockPositionId: input.stockPositionId,
          stockReservationId: input.stockReservationId,
          reservedQuantity: position.reserved_quantity,
          separatingQuantity: position.separating_quantity,
          availableQuantity: position.available_quantity,
          version: position.version
        }),
        JSON.stringify({
          stockPositionId: input.stockPositionId,
          stockReservationId: input.stockReservationId,
          reservedQuantity: position.reserved_quantity - input.quantity,
          separatingQuantity: position.separating_quantity + input.quantity,
          availableQuantity: position.available_quantity,
          version: position.version + 1
        }),
        input.summary,
        input.correlationId
      ]
    );

    return { ok: true, separationId };
  }
}

function hashSeparateStockCommand(input: SeparateStockCommand): string {
  const payload = {
    code: input.code,
    stockPositionId: input.stockPositionId,
    stockReservationId: input.stockReservationId,
    quantity: input.quantity,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): SeparateStockResult {
  if (isSeparateStockResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isSeparateStockResult(value: unknown): value is SeparateStockResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { separationId?: unknown }).separationId === "string";
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
