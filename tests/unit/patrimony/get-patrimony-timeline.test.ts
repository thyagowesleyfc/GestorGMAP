import { describe, expect, it, vi } from "vitest";

import {
  GetPatrimonyTimeline,
  type PatrimonyTimelineReader
} from "../../../src/modules/patrimony/application/get-patrimony-timeline";

describe("GetPatrimonyTimeline", () => {
  it("rejeita identificação patrimonial vazia sem consultar a persistência", async () => {
    const reader: PatrimonyTimelineReader = { get: vi.fn() };
    const query = new GetPatrimonyTimeline(reader);

    await expect(query.execute({ patrimonyId: "  ", actorUserId: "user-1" })).resolves.toEqual({
      ok: false,
      reason: "INVALID_PATRIMONY_ID"
    });
    expect(reader.get).not.toHaveBeenCalled();
  });

  it("normaliza o contexto e aplica paginação padrão", async () => {
    const reader: PatrimonyTimelineReader = {
      get: vi.fn().mockResolvedValue({
        ok: true,
        timeline: {
          patrimony: {
            id: "patrimony-1",
            materialSingularId: "material-1",
            materialCode: "MAT-1",
            materialName: "Material",
            responsibleEntityId: "entity-1",
            responsibleEntityCode: "ENT-1",
            responsibleEntityName: "Entidade",
            operationalState: "EM_USO"
          },
          entries: [],
          page: { limit: 50, offset: 0, returned: 0, total: 0 }
        }
      })
    };
    const query = new GetPatrimonyTimeline(reader);

    await expect(
      query.execute({ patrimonyId: " patrimony-1 ", actorUserId: " user-1 " })
    ).resolves.toMatchObject({ ok: true });
    expect(reader.get).toHaveBeenCalledWith({
      patrimonyId: "patrimony-1",
      actorUserId: "user-1",
      limit: 50,
      offset: 0
    });
  });

  it("rejeita paginação fora do limite", async () => {
    const reader: PatrimonyTimelineReader = { get: vi.fn() };
    const query = new GetPatrimonyTimeline(reader);

    await expect(
      query.execute({ patrimonyId: "patrimony-1", actorUserId: "user-1", limit: 201 })
    ).resolves.toEqual({ ok: false, reason: "INVALID_PAGINATION" });
    expect(reader.get).not.toHaveBeenCalled();
  });
});
