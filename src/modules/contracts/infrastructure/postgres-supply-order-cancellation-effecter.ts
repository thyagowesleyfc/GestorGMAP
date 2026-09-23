import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  EffectSupplyOrderCancellationCommand,
  EffectSupplyOrderCancellationResult,
  SupplyOrderCancellationEffecter
} from "../application/effect-supply-order-cancellation";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: EffectSupplyOrderCancellationResult }
  | { kind: "CONFLICT" };

type CancellationRow = {
  id: string;
  supply_order_id: string;
  status: "PREPARADA" | "AUTORIZADA" | "EFETIVADA" | "REJEITADA";
  authorized_at: Date | null;
};

type SupplyOrderRow = {
  id: string;
  code: string;
  status: "EMITIDA" | "CANCELADA";
};

type SupplyOrderItemRow = {
  contract_item_id: string;
  line_number: number;
  quantity: number;
  total_amount: string;
};

type LockedBalanceRow = {
  contract_item_id: string;
};

const EFFECT_SUPPLY_ORDER_CANCELLATION_COMMAND = "contracts.effect_supply_order_cancellation";

export class PostgresSupplyOrderCancellationEffecter implements SupplyOrderCancellationEffecter {
  constructor(private readonly pool: Pool) {}

  async effect(
    input: EffectSupplyOrderCancellationCommand
  ): Promise<EffectSupplyOrderCancellationResult> {
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

      const result = await this.effectInTransaction(client, input);
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
    input: EffectSupplyOrderCancellationCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashEffectCancellationCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, EFFECT_SUPPLY_ORDER_CANCELLATION_COMMAND, input.commandId, requestHash]
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
      [EFFECT_SUPPLY_ORDER_CANCELLATION_COMMAND, input.commandId]
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
    result: EffectSupplyOrderCancellationResult
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

  private async effectInTransaction(
    client: PoolClient,
    input: EffectSupplyOrderCancellationCommand
  ): Promise<EffectSupplyOrderCancellationResult> {
    const cancellationResult = await client.query<CancellationRow>(
      `select "id", "supply_order_id", "status"::text as "status"
         from "supply_order_cancellation"
        where "id" = $1
        for update`,
      [input.cancellationId]
    );
    const cancellation = cancellationResult.rows[0];

    if (cancellation === undefined) {
      return { ok: false, reason: "CANCELLATION_NOT_FOUND" };
    }

    if (cancellation.status !== "AUTORIZADA") {
      return { ok: false, reason: "CANCELLATION_NOT_AUTHORIZED" };
    }

    const supplyOrderResult = await client.query<SupplyOrderRow>(
      `select "id", "code", "status"::text as "status"
         from "supply_order"
        where "id" = $1
        for update`,
      [cancellation.supply_order_id]
    );
    const supplyOrder = supplyOrderResult.rows[0];

    if (supplyOrder === undefined || supplyOrder.status !== "EMITIDA") {
      return { ok: false, reason: "SUPPLY_ORDER_ALREADY_CANCELLED" };
    }

    const itemsResult = await client.query<SupplyOrderItemRow>(
      `select "contract_item_id", "line_number", "quantity", "total_amount"::text
         from "supply_order_item"
        where "supply_order_id" = $1
        order by "contract_item_id"`,
      [supplyOrder.id]
    );
    const items = itemsResult.rows;

    if (items.length === 0) {
      return { ok: false, reason: "SUPPLY_ORDER_HAS_NO_ITEMS" };
    }

    const contractItemIds = items.map((item) => item.contract_item_id);
    const lockedBalances = await client.query<LockedBalanceRow>(
      `select "contract_item_id"
         from "contract_balance_position"
        where "contract_item_id" = any($1::uuid[])
        order by "contract_item_id"
        for update`,
      [contractItemIds]
    );

    if (lockedBalances.rows.length !== contractItemIds.length) {
      const lockedIds = new Set(lockedBalances.rows.map((row) => row.contract_item_id));
      const missingId = contractItemIds.find((id) => !lockedIds.has(id));

      return {
        ok: false,
        reason: "BALANCE_POSITION_NOT_FOUND",
        contractItemId: missingId
      };
    }

    for (const item of items) {
      await client.query(
        `update "contract_balance_position"
            set "committed_quantity" = "committed_quantity" - $2,
                "available_quantity" = "available_quantity" + $2,
                "committed_amount" = "committed_amount" - $3,
                "available_amount" = "available_amount" + $3,
                "version" = "version" + 1,
                "updated_at" = current_timestamp
          where "contract_item_id" = $1`,
        [item.contract_item_id, item.quantity, item.total_amount]
      );

      await client.query(
        `insert into "contract_balance_movement" (
          "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
        ) values ($1, $2, $3, 'CANCELAMENTO_OF', $4, $5, $6, $7)`,
        [
          randomUUID(),
          `${supplyOrder.code}-CE-${item.line_number.toString().padStart(3, "0")}`,
          item.contract_item_id,
          item.quantity,
          item.total_amount,
          input.effectiveAt,
          `Estorno de comprometimento pelo cancelamento da OF ${supplyOrder.code}`
        ]
      );
    }

    await client.query(
      `update "supply_order_cancellation"
          set "status" = 'EFETIVADA',
              "effective_at" = $2,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.cancellationId, input.effectiveAt]
    );

    await client.query(
      `update "supply_order"
          set "status" = 'CANCELADA',
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [supplyOrder.id]
    );

    return {
      ok: true,
      cancellationId: input.cancellationId,
      supplyOrderId: supplyOrder.id,
      status: "EFETIVADA"
    };
  }
}

function hashEffectCancellationCommand(input: EffectSupplyOrderCancellationCommand): string {
  const payload = {
    cancellationId: input.cancellationId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): EffectSupplyOrderCancellationResult {
  if (isEffectSupplyOrderCancellationResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isEffectSupplyOrderCancellationResult(
  value: unknown
): value is EffectSupplyOrderCancellationResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { cancellationId?: unknown }).cancellationId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
