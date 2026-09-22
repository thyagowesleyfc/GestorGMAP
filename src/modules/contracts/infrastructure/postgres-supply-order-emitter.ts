import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  EmitSupplyOrderCommand,
  EmitSupplyOrderResult,
  SupplyOrderEmitter
} from "../application/emit-supply-order";

type LockedContractItemBalance = {
  contract_item_id: string;
  contract_id: string;
  unit_price: string;
  available_quantity: number;
  available_amount: string;
};

type ContractItemIdentity = {
  id: string;
  contract_id: string;
};

const UNIQUE_VIOLATION = "23505";

export class PostgresSupplyOrderEmitter implements SupplyOrderEmitter {
  constructor(private readonly pool: Pool) {}

  async emit(input: EmitSupplyOrderCommand): Promise<EmitSupplyOrderResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const result = await this.emitInTransaction(client, input);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "supply_order_code_key") {
          return { ok: false, reason: "DUPLICATE_SUPPLY_ORDER_CODE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async emitInTransaction(
    client: PoolClient,
    input: EmitSupplyOrderCommand
  ): Promise<EmitSupplyOrderResult> {
    const sortedContractItemIds = [...input.items]
      .map((item) => item.contractItemId)
      .sort((left, right) => left.localeCompare(right));

    const lockedBalances = await client.query<LockedContractItemBalance>(
      `select ci.id as contract_item_id,
              ci.contract_id,
              ci.unit_price::text,
              cbp.available_quantity,
              cbp.available_amount::text
         from "contract_item" ci
         join "contract_balance_position" cbp on cbp."contract_item_id" = ci."id"
        where ci."id" = any($1::uuid[])
        order by ci."id"
        for update of cbp`,
      [sortedContractItemIds]
    );

    if (lockedBalances.rows.length !== sortedContractItemIds.length) {
      return this.resolveMissingItemReason(client, sortedContractItemIds, lockedBalances.rows);
    }

    const balancesByItem = new Map(
      lockedBalances.rows.map((row) => [row.contract_item_id, row] as const)
    );

    for (const item of input.items) {
      const balance = balancesByItem.get(item.contractItemId);

      if (balance === undefined) {
        return {
          ok: false,
          reason: "BALANCE_POSITION_NOT_FOUND",
          contractItemId: item.contractItemId
        };
      }

      if (balance.contract_id !== input.contractId) {
        return {
          ok: false,
          reason: "ITEM_CONTRACT_MISMATCH",
          contractItemId: item.contractItemId
        };
      }

      const totalAmountCents = decimalToCents(balance.unit_price) * BigInt(item.quantity);

      if (
        balance.available_quantity < item.quantity ||
        decimalToCents(balance.available_amount) < totalAmountCents
      ) {
        return {
          ok: false,
          reason: "INSUFFICIENT_CONTRACT_BALANCE",
          contractItemId: item.contractItemId
        };
      }
    }

    const supplyOrderId = randomUUID();

    await client.query(
      `insert into "supply_order" (
        "id", "code", "contract_id", "issued_at", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)`,
      [supplyOrderId, input.code, input.contractId, input.issuedAt]
    );

    for (const item of input.items) {
      const balance = balancesByItem.get(item.contractItemId);

      if (balance === undefined) {
        throw new Error("Locked balance disappeared during supply order emission.");
      }

      const totalAmountCents = decimalToCents(balance.unit_price) * BigInt(item.quantity);
      const totalAmount = centsToDecimal(totalAmountCents);
      const movementCode = `${input.code}-CM-${item.lineNumber.toString().padStart(3, "0")}`;

      await client.query(
        `insert into "supply_order_item" (
          "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
        [
          randomUUID(),
          supplyOrderId,
          input.contractId,
          item.contractItemId,
          item.lineNumber,
          item.quantity,
          balance.unit_price,
          totalAmount
        ]
      );

      await client.query(
        `update "contract_balance_position"
            set "committed_quantity" = "committed_quantity" + $2,
                "available_quantity" = "available_quantity" - $2,
                "committed_amount" = "committed_amount" + $3,
                "available_amount" = "available_amount" - $3,
                "version" = "version" + 1,
                "updated_at" = current_timestamp
          where "contract_item_id" = $1`,
        [item.contractItemId, item.quantity, totalAmount]
      );

      await client.query(
        `insert into "contract_balance_movement" (
          "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
        ) values ($1, $2, $3, 'COMPROMETIMENTO_OF', $4, $5, $6, $7)`,
        [
          randomUUID(),
          movementCode,
          item.contractItemId,
          -item.quantity,
          centsToDecimal(-totalAmountCents),
          input.issuedAt,
          `Comprometimento de saldo pela OF ${input.code}`
        ]
      );
    }

    return { ok: true, supplyOrderId };
  }

  private async resolveMissingItemReason(
    client: PoolClient,
    requestedContractItemIds: string[],
    lockedBalances: LockedContractItemBalance[]
  ): Promise<EmitSupplyOrderResult> {
    const existingItems = await client.query<ContractItemIdentity>(
      `select "id", "contract_id"
         from "contract_item"
        where "id" = any($1::uuid[])`,
      [requestedContractItemIds]
    );
    const existingItemIds = new Set(existingItems.rows.map((row) => row.id));
    const lockedBalanceIds = new Set(lockedBalances.map((row) => row.contract_item_id));
    const missingItemId = requestedContractItemIds.find((id) => !existingItemIds.has(id));

    if (missingItemId !== undefined) {
      return { ok: false, reason: "CONTRACT_ITEM_NOT_FOUND", contractItemId: missingItemId };
    }

    const missingBalanceId = requestedContractItemIds.find((id) => !lockedBalanceIds.has(id));

    return {
      ok: false,
      reason: "BALANCE_POSITION_NOT_FOUND",
      contractItemId: missingBalanceId
    };
  }
}

function decimalToCents(value: string): bigint {
  const sign = value.startsWith("-") ? -1n : 1n;
  const unsignedValue = value.replace(/^-/, "");
  const [units, fraction = ""] = unsignedValue.split(".");
  const cents = `${fraction}00`.slice(0, 2);

  return sign * (BigInt(units) * 100n + BigInt(cents));
}

function centsToDecimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? -value : value;
  const units = absoluteValue / 100n;
  const cents = (absoluteValue % 100n).toString().padStart(2, "0");

  return `${sign}${units.toString()}.${cents}`;
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
