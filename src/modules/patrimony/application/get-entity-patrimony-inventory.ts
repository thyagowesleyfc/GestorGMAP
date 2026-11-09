export type GetEntityPatrimonyInventoryInput = {
  entityId: string;
  actorUserId: string;
  limit?: number;
  offset?: number;
  includeWrittenOff?: boolean;
  materialCode?: string;
  operationalStates?: string[];
};

export type GetEntityPatrimonyInventoryQuery = {
  entityId: string;
  actorUserId: string;
  limit: number;
  offset: number;
  includeWrittenOff: boolean;
  materialCode: string | null;
  operationalStates: PatrimonyOperationalState[];
};

export type PatrimonyOperationalState = "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";

export type PatrimonyControlType = "INDIVIDUAL" | "QUANTITATIVO" | "CONSUMO";

export type EntityPatrimonyInventoryEntry = {
  patrimonyId: string;
  materialSingularId: string;
  materialCode: string;
  materialName: string;
  controlType: PatrimonyControlType;
  isTombable: boolean;
  operationalState: PatrimonyOperationalState;
  incorporatedAt: string | null;
  activeTombo: {
    id: string;
    tombo: string;
    patrimonialGroupCode: string;
    issuedAt: string;
  } | null;
  latestComposition: {
    revision: number;
    configurationCode: string;
    configurationName: string;
    configurationType: "KIT" | "COMPOSTO";
    recordedAt: string;
  } | null;
};

export type EntityPatrimonyInventoryEntity = {
  id: string;
  code: string;
  name: string;
  greCode: string;
};

export type EntityPatrimonyInventoryPage = {
  limit: number;
  offset: number;
  returned: number;
  total: number;
};

export type EntityPatrimonyInventory = {
  entity: EntityPatrimonyInventoryEntity;
  entries: EntityPatrimonyInventoryEntry[];
  page: EntityPatrimonyInventoryPage;
};

export type GetEntityPatrimonyInventoryFailureReason =
  | "INVALID_ENTITY_ID"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_PAGINATION"
  | "INVALID_OPERATIONAL_STATE_FILTER"
  | "ENTITY_NOT_FOUND"
  | "ACTOR_NOT_AUTHORIZED";

export type GetEntityPatrimonyInventoryResult =
  | { ok: true; inventory: EntityPatrimonyInventory }
  | { ok: false; reason: GetEntityPatrimonyInventoryFailureReason };

export type EntityPatrimonyInventoryReader = {
  get(input: GetEntityPatrimonyInventoryQuery): Promise<GetEntityPatrimonyInventoryResult>;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export class GetEntityPatrimonyInventory {
  constructor(private readonly reader: EntityPatrimonyInventoryReader) {}

  async execute(
    input: GetEntityPatrimonyInventoryInput
  ): Promise<GetEntityPatrimonyInventoryResult> {
    const entityId = input.entityId.trim();
    const actorUserId = input.actorUserId.trim();
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;
    const materialCode = input.materialCode?.trim() || null;
    const operationalStates = (input.operationalStates ?? []).map((state) =>
      state.trim().toUpperCase()
    );

    if (entityId.length === 0) {
      return { ok: false, reason: "INVALID_ENTITY_ID" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (!isValidPage(limit, offset)) {
      return { ok: false, reason: "INVALID_PAGINATION" };
    }

    if (!operationalStates.every(isOperationalState)) {
      return { ok: false, reason: "INVALID_OPERATIONAL_STATE_FILTER" };
    }

    return this.reader.get({
      entityId,
      actorUserId,
      limit,
      offset,
      includeWrittenOff: input.includeWrittenOff ?? false,
      materialCode,
      operationalStates: operationalStates as PatrimonyOperationalState[]
    });
  }
}

function isOperationalState(value: string): value is PatrimonyOperationalState {
  return ["EM_USO", "RECOLHIDO", "EM_MANUTENCAO", "BAIXADO"].includes(value);
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
