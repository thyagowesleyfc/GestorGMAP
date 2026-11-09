export type GetPatrimonyTimelineInput = {
  patrimonyId: string;
  actorUserId: string;
  limit?: number;
  offset?: number;
};

export type GetPatrimonyTimelineQuery = {
  patrimonyId: string;
  actorUserId: string;
  limit: number;
  offset: number;
};

export type PatrimonyTimelineEventType =
  | "INCORPORACAO"
  | "TOMBO_GERADO"
  | "TOMBO_ENCERRADO"
  | "COMPOSICAO_REGISTRADA"
  | "MOVIMENTO"
  | "BAIXA"
  | "RETIFICACAO";

export type PatrimonyTimelineEvent = {
  id: string;
  occurredAt: string;
  eventType: PatrimonyTimelineEventType;
  referenceId: string;
  correlationId: string | null;
  details: Record<string, unknown>;
};

export type PatrimonyTimelinePatrimony = {
  id: string;
  materialSingularId: string;
  materialCode: string;
  materialName: string;
  responsibleEntityId: string;
  responsibleEntityCode: string;
  responsibleEntityName: string;
  operationalState: "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";
};

export type PatrimonyTimelinePage = {
  limit: number;
  offset: number;
  returned: number;
  total: number;
};

export type PatrimonyTimeline = {
  patrimony: PatrimonyTimelinePatrimony;
  entries: PatrimonyTimelineEvent[];
  page: PatrimonyTimelinePage;
};

export type GetPatrimonyTimelineFailureReason =
  | "INVALID_PATRIMONY_ID"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_PAGINATION"
  | "PATRIMONY_NOT_FOUND"
  | "ACTOR_NOT_AUTHORIZED";

export type GetPatrimonyTimelineResult =
  | { ok: true; timeline: PatrimonyTimeline }
  | { ok: false; reason: GetPatrimonyTimelineFailureReason };

export type PatrimonyTimelineReader = {
  get(input: GetPatrimonyTimelineQuery): Promise<GetPatrimonyTimelineResult>;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export class GetPatrimonyTimeline {
  constructor(private readonly reader: PatrimonyTimelineReader) {}

  async execute(input: GetPatrimonyTimelineInput): Promise<GetPatrimonyTimelineResult> {
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
