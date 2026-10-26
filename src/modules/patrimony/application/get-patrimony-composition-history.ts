export type GetPatrimonyCompositionHistoryInput = {
  patrimonyId: string;
  actorUserId: string;
  limit?: number;
  offset?: number;
};

export type GetPatrimonyCompositionHistoryQuery = {
  patrimonyId: string;
  actorUserId: string;
  limit: number;
  offset: number;
};

export type PatrimonyCompositionHistoryItem = {
  lineNumber: number;
  materialSingularId: string;
  componentPatrimonyId: string | null;
  quantity: number;
  materialCode: string;
  materialName: string;
  isTombable: boolean;
  patrimonialGroupCode: string | null;
};

export type PatrimonyCompositionHistoryRevision = {
  compositionId: string;
  revision: number;
  materialConfigurationId: string;
  configurationCode: string;
  configurationName: string;
  configurationType: "KIT" | "COMPOSTO";
  recordedAt: string;
  items: PatrimonyCompositionHistoryItem[];
};

export type PatrimonyCompositionHistoryPatrimony = {
  id: string;
  materialSingularId: string;
  materialCode: string;
  materialName: string;
  responsibleEntityId: string;
  responsibleEntityCode: string;
  responsibleEntityName: string;
};

export type PatrimonyCompositionHistoryPage = {
  limit: number;
  offset: number;
  returned: number;
  total: number;
};

export type PatrimonyCompositionHistory = {
  patrimony: PatrimonyCompositionHistoryPatrimony;
  revisions: PatrimonyCompositionHistoryRevision[];
  page: PatrimonyCompositionHistoryPage;
};

export type GetPatrimonyCompositionHistoryFailureReason =
  | "INVALID_PATRIMONY_ID"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_PAGINATION"
  | "PATRIMONY_NOT_FOUND"
  | "ACTOR_NOT_AUTHORIZED";

export type GetPatrimonyCompositionHistoryResult =
  | { ok: true; history: PatrimonyCompositionHistory }
  | { ok: false; reason: GetPatrimonyCompositionHistoryFailureReason };

export type PatrimonyCompositionHistoryReader = {
  get(input: GetPatrimonyCompositionHistoryQuery): Promise<GetPatrimonyCompositionHistoryResult>;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export class GetPatrimonyCompositionHistory {
  constructor(private readonly reader: PatrimonyCompositionHistoryReader) {}

  async execute(
    input: GetPatrimonyCompositionHistoryInput
  ): Promise<GetPatrimonyCompositionHistoryResult> {
    const patrimonyId = input.patrimonyId.trim();
    const actorUserId = input.actorUserId.trim();
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (!isValidPage(limit, offset)) {
      return { ok: false, reason: "INVALID_PAGINATION" };
    }

    return this.reader.get({ patrimonyId, actorUserId, limit, offset });
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
