export type EmitSupplyOrderItemInput = {
  contractItemId: string;
  quantity: number;
};

export type EmitSupplyOrderInput = {
  code: string;
  contractId: string;
  issuedAt?: Date;
  items: EmitSupplyOrderItemInput[];
};

export type EmitSupplyOrderCommand = {
  code: string;
  contractId: string;
  issuedAt: Date;
  items: Array<EmitSupplyOrderItemInput & { lineNumber: number }>;
};

export type EmitSupplyOrderFailureReason =
  | "EMPTY_ITEMS"
  | "INVALID_ITEM_QUANTITY"
  | "DUPLICATE_CONTRACT_ITEM"
  | "DUPLICATE_SUPPLY_ORDER_CODE"
  | "CONTRACT_ITEM_NOT_FOUND"
  | "BALANCE_POSITION_NOT_FOUND"
  | "ITEM_CONTRACT_MISMATCH"
  | "INSUFFICIENT_CONTRACT_BALANCE";

export type EmitSupplyOrderResult =
  | {
      ok: true;
      supplyOrderId: string;
    }
  | {
      ok: false;
      reason: EmitSupplyOrderFailureReason;
      contractItemId?: string;
    };

export type SupplyOrderEmitter = {
  emit(input: EmitSupplyOrderCommand): Promise<EmitSupplyOrderResult>;
};

export class EmitSupplyOrder {
  constructor(private readonly emitter: SupplyOrderEmitter) {}

  async execute(input: EmitSupplyOrderInput): Promise<EmitSupplyOrderResult> {
    if (input.items.length === 0) {
      return { ok: false, reason: "EMPTY_ITEMS" };
    }

    const seenContractItems = new Set<string>();
    const items = input.items.map((item, index) => {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        return { ...item, lineNumber: index + 1, invalid: true as const };
      }

      return { ...item, lineNumber: index + 1, invalid: false as const };
    });

    const invalidItem = items.find((item) => item.invalid);
    if (invalidItem !== undefined) {
      return {
        ok: false,
        reason: "INVALID_ITEM_QUANTITY",
        contractItemId: invalidItem.contractItemId
      };
    }

    for (const item of items) {
      if (seenContractItems.has(item.contractItemId)) {
        return {
          ok: false,
          reason: "DUPLICATE_CONTRACT_ITEM",
          contractItemId: item.contractItemId
        };
      }

      seenContractItems.add(item.contractItemId);
    }

    return this.emitter.emit({
      code: input.code,
      contractId: input.contractId,
      issuedAt: input.issuedAt ?? new Date(),
      items: items.map((item) => ({
        contractItemId: item.contractItemId,
        quantity: item.quantity,
        lineNumber: item.lineNumber
      }))
    });
  }
}
