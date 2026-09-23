import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  PrepareSupplyOrderCancellationCommand,
  PrepareSupplyOrderCancellationResult,
  SupplyOrderCancellationPreparer
} from "../application/prepare-supply-order-cancellation";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: PrepareSupplyOrderCancellationResult }
  | { kind: "CONFLICT" };

type SupplyOrderRow = {
  id: string;
  status: "EMITIDA" | "CANCELADA";
};

type ExistingCancellationRow = {
  id: string;
};

const PREPARE_SUPPLY_ORDER_CANCELLATION_COMMAND = "contracts.prepare_supply_order_cancellation";

export class PostgresSupplyOrderCancellationPreparer implements SupplyOrderCancellationPreparer {
  constructor(private readonly pool: Pool) {}

  async prepare(
    input: PrepareSupplyOrderCancellationCommand
  ): Promise<PrepareSupplyOrderCancellationResult> {
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

      const result = await this.prepareInTransaction(client, input);
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
    input: PrepareSupplyOrderCancellationCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashPrepareCancellationCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, PREPARE_SUPPLY_ORDER_CANCELLATION_COMMAND, input.commandId, requestHash]
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
      [PREPARE_SUPPLY_ORDER_CANCELLATION_COMMAND, input.commandId]
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
    result: PrepareSupplyOrderCancellationResult
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

  private async prepareInTransaction(
    client: PoolClient,
    input: PrepareSupplyOrderCancellationCommand
  ): Promise<PrepareSupplyOrderCancellationResult> {
    const supplyOrder = await client.query<SupplyOrderRow>(
      `select "id", "status"
         from "supply_order"
        where "id" = $1
        for update`,
      [input.supplyOrderId]
    );
    const row = supplyOrder.rows[0];

    if (row === undefined) {
      return { ok: false, reason: "SUPPLY_ORDER_NOT_FOUND" };
    }

    if (row.status !== "EMITIDA") {
      return { ok: false, reason: "SUPPLY_ORDER_NOT_CANCELABLE" };
    }

    const existingCancellation = await client.query<ExistingCancellationRow>(
      `select "id"
         from "supply_order_cancellation"
        where "supply_order_id" = $1`,
      [input.supplyOrderId]
    );

    if (existingCancellation.rows.length > 0) {
      return { ok: false, reason: "CANCELLATION_ALREADY_EXISTS" };
    }

    const cancellationId = randomUUID();

    await client.query(
      `insert into "supply_order_cancellation" (
        "id", "supply_order_id", "reason", "prepared_at", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)`,
      [cancellationId, input.supplyOrderId, input.reason, input.preparedAt]
    );

    return { ok: true, cancellationId, status: "PREPARADA" };
  }
}

function hashPrepareCancellationCommand(input: PrepareSupplyOrderCancellationCommand): string {
  const payload = {
    supplyOrderId: input.supplyOrderId,
    reason: input.reason
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): PrepareSupplyOrderCancellationResult {
  if (isPrepareSupplyOrderCancellationResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isPrepareSupplyOrderCancellationResult(
  value: unknown
): value is PrepareSupplyOrderCancellationResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { cancellationId?: unknown }).cancellationId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
