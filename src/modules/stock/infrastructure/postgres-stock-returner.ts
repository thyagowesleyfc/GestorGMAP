import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  ReturnStockCommand,
  ReturnStockResult,
  StockReturner
} from "../application/return-stock";

type IdempotencyRow = {
  id: string;
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReturn =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: ReturnStockResult }
  | { kind: "CONFLICT" };

type LockedStockPosition = {
  id: string;
  reserved_quantity: number;
  separating_quantity: number;
  available_quantity: number;
  version: number;
};

type LockedStockSeparation = {
  id: string;
  quantity: number;
};

type ExistingReturnQuantity = {
  returned_quantity: number;
};

const UNIQUE_VIOLATION = "23505";
const RETURN_STOCK_COMMAND = "stock.return_stock";

export class PostgresStockReturner implements StockReturner {
  constructor(private readonly pool: Pool) {}

  async return(input: ReturnStockCommand): Promise<ReturnStockResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const stockReturn = await this.reserveIdempotency(client, input);
      if (stockReturn.kind === "REPLAY") {
        await client.query("commit");
        return stockReturn.result;
      }

      if (stockReturn.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" };
      }

      const result = await this.returnInTransaction(client, input);
      await this.storeIdempotencyResult(client, stockReturn.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "stock_return_code_key") {
          return { ok: false, reason: "DUPLICATE_RETURN_CODE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: ReturnStockCommand
  ): Promise<IdempotencyReturn> {
    const requestHash = hashReturnStockCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, RETURN_STOCK_COMMAND, input.commandId, requestHash]
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
      [RETURN_STOCK_COMMAND, input.commandId]
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
    result: ReturnStockResult
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

  private async returnInTransaction(
    client: PoolClient,
    input: ReturnStockCommand
  ): Promise<ReturnStockResult> {
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

    const stockSeparation = await client.query<LockedStockSeparation>(
      `select "id", "quantity"
         from "stock_separation"
        where "id" = $1
          and "stock_position_id" = $2
          and "status" = 'EM_SEPARACAO'
        for update`,
      [input.stockSeparationId, input.stockPositionId]
    );
    const separation = stockSeparation.rows[0];

    if (separation === undefined) {
      return {
        ok: false,
        reason: "STOCK_SEPARATION_NOT_FOUND",
        stockPositionId: input.stockPositionId,
        stockSeparationId: input.stockSeparationId
      };
    }

    const existingReturn = await client.query<ExistingReturnQuantity>(
      `select coalesce(sum("quantity"), 0)::int as "returned_quantity"
         from "stock_return"
        where "stock_separation_id" = $1`,
      [input.stockSeparationId]
    );
    const alreadyReturned = existingReturn.rows[0]?.returned_quantity ?? 0;

    if (
      position.separating_quantity < input.quantity ||
      separation.quantity - alreadyReturned < input.quantity
    ) {
      return {
        ok: false,
        reason: "INSUFFICIENT_SEPARATING_STOCK",
        stockPositionId: input.stockPositionId,
        stockSeparationId: input.stockSeparationId
      };
    }

    const returnId = randomUUID();

    await client.query(
      `insert into "stock_return" (
        "id", "code", "stock_position_id", "stock_separation_id",
        "quantity", "returned_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
      [
        returnId,
        input.code,
        input.stockPositionId,
        input.stockSeparationId,
        input.quantity,
        input.returnedAt,
        input.summary
      ]
    );

    await client.query(
      `update "stock_position"
          set "separating_quantity" = "separating_quantity" - $2,
              "available_quantity" = "available_quantity" + $2,
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
        input.returnedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        RETURN_STOCK_COMMAND,
        "stock_return",
        returnId,
        JSON.stringify({
          stockPositionId: input.stockPositionId,
          stockSeparationId: input.stockSeparationId,
          reservedQuantity: position.reserved_quantity,
          separatingQuantity: position.separating_quantity,
          availableQuantity: position.available_quantity,
          version: position.version
        }),
        JSON.stringify({
          stockPositionId: input.stockPositionId,
          stockSeparationId: input.stockSeparationId,
          reservedQuantity: position.reserved_quantity,
          separatingQuantity: position.separating_quantity - input.quantity,
          availableQuantity: position.available_quantity + input.quantity,
          version: position.version + 1
        }),
        input.summary,
        input.correlationId
      ]
    );

    return { ok: true, returnId };
  }
}

function hashReturnStockCommand(input: ReturnStockCommand): string {
  const payload = {
    code: input.code,
    stockPositionId: input.stockPositionId,
    stockSeparationId: input.stockSeparationId,
    quantity: input.quantity,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): ReturnStockResult {
  if (isReturnStockResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isReturnStockResult(value: unknown): value is ReturnStockResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { returnId?: unknown }).returnId === "string";
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
