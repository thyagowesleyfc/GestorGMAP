import { Pool } from "pg";

import type {
  ContractStatementContract,
  ContractStatementItem,
  ContractStatementMovement,
  ContractStatementReader,
  ContractStatementSupplyOrder,
  ContractStatementTotals,
  GetContractStatementQuery,
  GetContractStatementResult
} from "../application/get-contract-statement";

type ContractRow = {
  id: string;
  code: string;
  supplier_name: string;
  object: string;
  validity_start: string;
  validity_end: string;
};

type ItemRow = {
  contract_item_id: string;
  code: string;
  line_number: number;
  contracted_quantity: number;
  unit_price: string;
  total_quantity: number | null;
  committed_quantity: number | null;
  available_quantity: number | null;
  total_amount: string | null;
  committed_amount: string | null;
  available_amount: string | null;
};

type MovementRow = {
  id: string;
  code: string;
  contract_item_id: string;
  contract_item_code: string;
  type: string;
  quantity_delta: number;
  amount_delta: string;
  occurred_at: string;
  summary: string;
};

type SupplyOrderRow = {
  id: string;
  code: string;
  status: string;
  issued_at: string;
  items_count: number;
  total_amount: string;
  cancellation_id: string | null;
  cancellation_status: string | null;
  cancellation_reason: string | null;
  prepared_at: string | null;
  authorized_at: string | null;
  effective_at: string | null;
  rejected_at: string | null;
};

const ZERO_DECIMAL = "0.00";

export class PostgresContractStatementReader implements ContractStatementReader {
  constructor(private readonly pool: Pool) {}

  async get(input: GetContractStatementQuery): Promise<GetContractStatementResult> {
    const contract = await this.pool.query<ContractRow>(
      `select c."id",
              c."code",
              s."name" as supplier_name,
              c."object",
              c."validity_start"::text,
              c."validity_end"::text
         from "contract" c
         join "supplier" s on s."id" = c."supplier_id"
        where c."id" = $1`,
      [input.contractId]
    );
    const contractRow = contract.rows[0];

    if (contractRow === undefined) {
      return { ok: false, reason: "CONTRACT_NOT_FOUND" };
    }

    const items = await this.pool.query<ItemRow>(
      `select ci."id" as contract_item_id,
              ci."code",
              ci."line_number",
              ci."contracted_quantity",
              ci."unit_price"::text,
              cbp."total_quantity",
              cbp."committed_quantity",
              cbp."available_quantity",
              cbp."total_amount"::text,
              cbp."committed_amount"::text,
              cbp."available_amount"::text
         from "contract_item" ci
         left join "contract_balance_position" cbp on cbp."contract_item_id" = ci."id"
        where ci."contract_id" = $1
        order by ci."line_number", ci."id"`,
      [input.contractId]
    );

    const movements = await this.pool.query<MovementRow>(
      `select cbm."id",
              cbm."code",
              cbm."contract_item_id",
              ci."code" as contract_item_code,
              cbm."type"::text,
              cbm."quantity_delta",
              cbm."amount_delta"::text,
              cbm."occurred_at"::text,
              cbm."summary"
         from "contract_balance_movement" cbm
         join "contract_item" ci on ci."id" = cbm."contract_item_id"
        where ci."contract_id" = $1
        order by cbm."occurred_at" desc, cbm."id" desc
        limit $2 offset $3`,
      [input.contractId, input.movementsLimit, input.movementsOffset]
    );

    const supplyOrders = await this.pool.query<SupplyOrderRow>(
      `select so."id",
              so."code",
              so."status"::text,
              so."issued_at"::text,
              count(soi."id")::int as items_count,
              coalesce(sum(soi."total_amount"), 0)::text as total_amount,
              soc."id" as cancellation_id,
              soc."status"::text as cancellation_status,
              soc."reason" as cancellation_reason,
              soc."prepared_at"::text,
              soc."authorized_at"::text,
              soc."effective_at"::text,
              soc."rejected_at"::text
         from "supply_order" so
         left join "supply_order_item" soi on soi."supply_order_id" = so."id"
         left join "supply_order_cancellation" soc on soc."supply_order_id" = so."id"
        where so."contract_id" = $1
        group by so."id",
                 so."code",
                 so."status",
                 so."issued_at",
                 soc."id",
                 soc."status",
                 soc."reason",
                 soc."prepared_at",
                 soc."authorized_at",
                 soc."effective_at",
                 soc."rejected_at"
        order by so."issued_at" desc, so."id" desc
        limit $2 offset $3`,
      [input.contractId, input.supplyOrdersLimit, input.supplyOrdersOffset]
    );

    const statementItems = items.rows.map(mapItemRow);

    return {
      ok: true,
      statement: {
        contract: mapContractRow(contractRow),
        totals: calculateTotals(statementItems),
        items: statementItems,
        movements: movements.rows.map(mapMovementRow),
        movementsPage: {
          limit: input.movementsLimit,
          offset: input.movementsOffset,
          returned: movements.rows.length
        },
        supplyOrders: supplyOrders.rows.map(mapSupplyOrderRow),
        supplyOrdersPage: {
          limit: input.supplyOrdersLimit,
          offset: input.supplyOrdersOffset,
          returned: supplyOrders.rows.length
        }
      }
    };
  }
}

function mapContractRow(row: ContractRow): ContractStatementContract {
  return {
    id: row.id,
    code: row.code,
    supplierName: row.supplier_name,
    object: row.object,
    validityStart: row.validity_start,
    validityEnd: row.validity_end
  };
}

function mapItemRow(row: ItemRow): ContractStatementItem {
  return {
    contractItemId: row.contract_item_id,
    code: row.code,
    lineNumber: row.line_number,
    contractedQuantity: row.contracted_quantity,
    unitPrice: row.unit_price,
    totalQuantity: row.total_quantity ?? 0,
    committedQuantity: row.committed_quantity ?? 0,
    availableQuantity: row.available_quantity ?? 0,
    totalAmount: row.total_amount ?? ZERO_DECIMAL,
    committedAmount: row.committed_amount ?? ZERO_DECIMAL,
    availableAmount: row.available_amount ?? ZERO_DECIMAL
  };
}

function mapMovementRow(row: MovementRow): ContractStatementMovement {
  return {
    id: row.id,
    code: row.code,
    contractItemId: row.contract_item_id,
    contractItemCode: row.contract_item_code,
    type: row.type,
    quantityDelta: row.quantity_delta,
    amountDelta: row.amount_delta,
    occurredAt: row.occurred_at,
    summary: row.summary
  };
}

function mapSupplyOrderRow(row: SupplyOrderRow): ContractStatementSupplyOrder {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    issuedAt: row.issued_at,
    itemsCount: row.items_count,
    totalAmount: row.total_amount,
    cancellation:
      row.cancellation_id === null ||
      row.cancellation_status === null ||
      row.cancellation_reason === null ||
      row.prepared_at === null
        ? null
        : {
            id: row.cancellation_id,
            status: row.cancellation_status,
            reason: row.cancellation_reason,
            preparedAt: row.prepared_at,
            authorizedAt: row.authorized_at,
            effectiveAt: row.effective_at,
            rejectedAt: row.rejected_at
          }
  };
}

function calculateTotals(items: ContractStatementItem[]): ContractStatementTotals {
  return {
    totalQuantity: items.reduce((total, item) => total + item.totalQuantity, 0),
    committedQuantity: items.reduce((total, item) => total + item.committedQuantity, 0),
    availableQuantity: items.reduce((total, item) => total + item.availableQuantity, 0),
    totalAmount: centsToDecimal(
      items.reduce((total, item) => total + decimalToCents(item.totalAmount), 0n)
    ),
    committedAmount: centsToDecimal(
      items.reduce((total, item) => total + decimalToCents(item.committedAmount), 0n)
    ),
    availableAmount: centsToDecimal(
      items.reduce((total, item) => total + decimalToCents(item.availableAmount), 0n)
    )
  };
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
