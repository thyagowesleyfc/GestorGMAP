export type GetContractStatementInput = {
  contractId: string;
  movementsLimit?: number;
  movementsOffset?: number;
  supplyOrdersLimit?: number;
  supplyOrdersOffset?: number;
};

export type GetContractStatementQuery = {
  contractId: string;
  movementsLimit: number;
  movementsOffset: number;
  supplyOrdersLimit: number;
  supplyOrdersOffset: number;
};

export type ContractStatementContract = {
  id: string;
  code: string;
  supplierName: string;
  object: string;
  validityStart: string;
  validityEnd: string;
};

export type ContractStatementItem = {
  contractItemId: string;
  code: string;
  lineNumber: number;
  contractedQuantity: number;
  unitPrice: string;
  totalQuantity: number;
  committedQuantity: number;
  availableQuantity: number;
  totalAmount: string;
  committedAmount: string;
  availableAmount: string;
};

export type ContractStatementMovement = {
  id: string;
  code: string;
  contractItemId: string;
  contractItemCode: string;
  type: string;
  quantityDelta: number;
  amountDelta: string;
  occurredAt: string;
  summary: string;
};

export type ContractStatementSupplyOrderCancellation = {
  id: string;
  status: string;
  reason: string;
  preparedAt: string;
  authorizedAt: string | null;
  effectiveAt: string | null;
  rejectedAt: string | null;
};

export type ContractStatementSupplyOrder = {
  id: string;
  code: string;
  status: string;
  issuedAt: string;
  itemsCount: number;
  totalAmount: string;
  cancellation: ContractStatementSupplyOrderCancellation | null;
};

export type ContractStatementTotals = {
  totalQuantity: number;
  committedQuantity: number;
  availableQuantity: number;
  totalAmount: string;
  committedAmount: string;
  availableAmount: string;
};

export type ContractStatementPage = {
  limit: number;
  offset: number;
  returned: number;
};

export type ContractStatement = {
  contract: ContractStatementContract;
  totals: ContractStatementTotals;
  items: ContractStatementItem[];
  movements: ContractStatementMovement[];
  movementsPage: ContractStatementPage;
  supplyOrders: ContractStatementSupplyOrder[];
  supplyOrdersPage: ContractStatementPage;
};

export type GetContractStatementFailureReason = "INVALID_PAGINATION" | "CONTRACT_NOT_FOUND";

export type GetContractStatementResult =
  | {
      ok: true;
      statement: ContractStatement;
    }
  | {
      ok: false;
      reason: GetContractStatementFailureReason;
    };

export type ContractStatementReader = {
  get(input: GetContractStatementQuery): Promise<GetContractStatementResult>;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export class GetContractStatement {
  constructor(private readonly reader: ContractStatementReader) {}

  async execute(input: GetContractStatementInput): Promise<GetContractStatementResult> {
    const movementsLimit = input.movementsLimit ?? DEFAULT_PAGE_LIMIT;
    const movementsOffset = input.movementsOffset ?? 0;
    const supplyOrdersLimit = input.supplyOrdersLimit ?? DEFAULT_PAGE_LIMIT;
    const supplyOrdersOffset = input.supplyOrdersOffset ?? 0;

    if (
      !isValidPage(movementsLimit, movementsOffset) ||
      !isValidPage(supplyOrdersLimit, supplyOrdersOffset)
    ) {
      return { ok: false, reason: "INVALID_PAGINATION" };
    }

    return this.reader.get({
      contractId: input.contractId,
      movementsLimit,
      movementsOffset,
      supplyOrdersLimit,
      supplyOrdersOffset
    });
  }
}

function isValidPage(limit: number, offset: number): boolean {
  return (
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_PAGE_LIMIT &&
    Number.isInteger(offset) &&
    offset >= 0
  );
}
