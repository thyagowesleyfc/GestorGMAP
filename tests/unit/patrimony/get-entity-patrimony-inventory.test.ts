import { describe, expect, it, vi } from "vitest";

import {
  GetEntityPatrimonyInventory,
  type EntityPatrimonyInventoryReader
} from "../../../src/modules/patrimony/application/get-entity-patrimony-inventory";

describe("GetEntityPatrimonyInventory", () => {
  it("rejeita Entidade vazia sem consultar a persistência", async () => {
    const reader: EntityPatrimonyInventoryReader = { get: vi.fn() };
    const query = new GetEntityPatrimonyInventory(reader);

    await expect(query.execute({ entityId: "  ", actorUserId: "user-1" })).resolves.toEqual({
      ok: false,
      reason: "INVALID_ENTITY_ID"
    });
    expect(reader.get).not.toHaveBeenCalled();
  });

  it("normaliza a entrada e exclui Baixados por padrão", async () => {
    const reader: EntityPatrimonyInventoryReader = {
      get: vi.fn().mockResolvedValue({
        ok: true,
        inventory: {
          entity: {
            id: "entity-1",
            code: "ENT-1",
            name: "Entidade",
            greCode: "GRE-1"
          },
          entries: [],
          page: { limit: 50, offset: 0, returned: 0, total: 0 }
        }
      })
    };
    const query = new GetEntityPatrimonyInventory(reader);

    await expect(
      query.execute({ entityId: " entity-1 ", actorUserId: " user-1 " })
    ).resolves.toMatchObject({ ok: true });
    expect(reader.get).toHaveBeenCalledWith({
      entityId: "entity-1",
      actorUserId: "user-1",
      limit: 50,
      offset: 0,
      includeWrittenOff: false,
      materialCode: null,
      operationalStates: []
    });
  });

  it("preserva a opção explícita de incluir Baixados", async () => {
    const reader: EntityPatrimonyInventoryReader = {
      get: vi.fn().mockResolvedValue({ ok: false, reason: "ENTITY_NOT_FOUND" })
    };
    const query = new GetEntityPatrimonyInventory(reader);

    await query.execute({
      entityId: "entity-1",
      actorUserId: "user-1",
      limit: 10,
      offset: 20,
      includeWrittenOff: true
    });
    expect(reader.get).toHaveBeenCalledWith({
      entityId: "entity-1",
      actorUserId: "user-1",
      limit: 10,
      offset: 20,
      includeWrittenOff: true,
      materialCode: null,
      operationalStates: []
    });
  });

  it("rejeita paginação inválida", async () => {
    const reader: EntityPatrimonyInventoryReader = { get: vi.fn() };
    const query = new GetEntityPatrimonyInventory(reader);

    await expect(
      query.execute({ entityId: "entity-1", actorUserId: "user-1", limit: 0 })
    ).resolves.toEqual({ ok: false, reason: "INVALID_PAGINATION" });
    expect(reader.get).not.toHaveBeenCalled();
  });

  it("normaliza filtros de material e estado operacional", async () => {
    const reader: EntityPatrimonyInventoryReader = {
      get: vi.fn().mockResolvedValue({ ok: false, reason: "ENTITY_NOT_FOUND" })
    };
    const query = new GetEntityPatrimonyInventory(reader);

    await query.execute({
      entityId: "entity-1",
      actorUserId: "user-1",
      materialCode: " MAT-001 ",
      operationalStates: [" em_uso ", "BAIXADO"]
    });
    expect(reader.get).toHaveBeenCalledWith({
      entityId: "entity-1",
      actorUserId: "user-1",
      limit: 50,
      offset: 0,
      includeWrittenOff: false,
      materialCode: "MAT-001",
      operationalStates: ["EM_USO", "BAIXADO"]
    });
  });

  it("rejeita estado operacional desconhecido", async () => {
    const reader: EntityPatrimonyInventoryReader = { get: vi.fn() };
    const query = new GetEntityPatrimonyInventory(reader);

    await expect(
      query.execute({
        entityId: "entity-1",
        actorUserId: "user-1",
        operationalStates: ["INEXISTENTE"]
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_OPERATIONAL_STATE_FILTER" });
    expect(reader.get).not.toHaveBeenCalled();
  });
});
