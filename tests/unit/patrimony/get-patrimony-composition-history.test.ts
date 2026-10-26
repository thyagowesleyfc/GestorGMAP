import { describe, expect, it, vi } from "vitest";

import {
  GetPatrimonyCompositionHistory,
  type PatrimonyCompositionHistoryReader
} from "../../../src/modules/patrimony/application/get-patrimony-composition-history";

describe("get patrimony composition history", () => {
  it("rejects invalid pagination before reaching persistence", async () => {
    const reader: PatrimonyCompositionHistoryReader = { get: vi.fn() };
    const query = new GetPatrimonyCompositionHistory(reader);

    await expect(
      query.execute({ patrimonyId: "patrimony-1", actorUserId: "user-1", limit: 0 })
    ).resolves.toEqual({ ok: false, reason: "INVALID_PAGINATION" });

    expect(reader.get).not.toHaveBeenCalled();
  });

  it("normalizes identifiers and applies default pagination", async () => {
    const result = {
      ok: true as const,
      history: {
        patrimony: {
          id: "patrimony-1",
          materialSingularId: "material-1",
          materialCode: "MAT-PAI",
          materialName: "Patrimônio pai",
          responsibleEntityId: "entity-1",
          responsibleEntityCode: "ENT-1",
          responsibleEntityName: "Entidade 1"
        },
        revisions: [],
        page: { limit: 50, offset: 0, returned: 0, total: 0 }
      }
    };
    const reader: PatrimonyCompositionHistoryReader = {
      get: vi.fn().mockResolvedValue(result)
    };
    const query = new GetPatrimonyCompositionHistory(reader);

    await expect(
      query.execute({ patrimonyId: " patrimony-1 ", actorUserId: " user-1 " })
    ).resolves.toEqual(result);

    expect(reader.get).toHaveBeenCalledWith({
      patrimonyId: "patrimony-1",
      actorUserId: "user-1",
      limit: 50,
      offset: 0
    });
  });
});
