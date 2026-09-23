import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  AuthorizeSupplyOrderCancellationCommand,
  AuthorizeSupplyOrderCancellationResult,
  SupplyOrderCancellationAuthorizer
} from "../application/authorize-supply-order-cancellation";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: AuthorizeSupplyOrderCancellationResult }
  | { kind: "CONFLICT" };

type CancellationRow = {
  id: string;
  status: "PREPARADA" | "AUTORIZADA" | "EFETIVADA" | "REJEITADA";
};

const AUTHORIZE_SUPPLY_ORDER_CANCELLATION_COMMAND = "contracts.authorize_supply_order_cancellation";

export class PostgresSupplyOrderCancellationAuthorizer implements SupplyOrderCancellationAuthorizer {
  constructor(private readonly pool: Pool) {}

  async authorize(
    input: AuthorizeSupplyOrderCancellationCommand
  ): Promise<AuthorizeSupplyOrderCancellationResult> {
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

      const result = await this.authorizeInTransaction(client, input);
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
    input: AuthorizeSupplyOrderCancellationCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashAuthorizeCancellationCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, AUTHORIZE_SUPPLY_ORDER_CANCELLATION_COMMAND, input.commandId, requestHash]
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
      [AUTHORIZE_SUPPLY_ORDER_CANCELLATION_COMMAND, input.commandId]
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
    result: AuthorizeSupplyOrderCancellationResult
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

  private async authorizeInTransaction(
    client: PoolClient,
    input: AuthorizeSupplyOrderCancellationCommand
  ): Promise<AuthorizeSupplyOrderCancellationResult> {
    const cancellation = await client.query<CancellationRow>(
      `select "id", "status"::text as "status"
         from "supply_order_cancellation"
        where "id" = $1
        for update`,
      [input.cancellationId]
    );
    const row = cancellation.rows[0];

    if (row === undefined) {
      return { ok: false, reason: "CANCELLATION_NOT_FOUND" };
    }

    if (row.status !== "PREPARADA") {
      return { ok: false, reason: "CANCELLATION_NOT_PREPARED" };
    }

    await client.query(
      `update "supply_order_cancellation"
          set "status" = 'AUTORIZADA',
              "authorized_at" = $2,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.cancellationId, input.authorizedAt]
    );

    return { ok: true, cancellationId: input.cancellationId, status: "AUTORIZADA" };
  }
}

function hashAuthorizeCancellationCommand(input: AuthorizeSupplyOrderCancellationCommand): string {
  const payload = {
    cancellationId: input.cancellationId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): AuthorizeSupplyOrderCancellationResult {
  if (isAuthorizeSupplyOrderCancellationResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isAuthorizeSupplyOrderCancellationResult(
  value: unknown
): value is AuthorizeSupplyOrderCancellationResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { cancellationId?: unknown }).cancellationId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
