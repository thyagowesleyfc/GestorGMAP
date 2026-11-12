import { describe, expect, it, vi } from "vitest";

import {
  ConfirmMaintenanceServiceOrder,
  type ConfirmMaintenanceServiceOrderInput,
  type MaintenanceServiceOrderConfirmer
} from "../../../src/modules/maintenance/application/confirm-maintenance-service-order";

const baseInput: ConfirmMaintenanceServiceOrderInput = {
  commandId: " command-1 ",
  serviceOrderId: " service-order-1 ",
  evidenceReference: " termo-entidade-1 ",
  confirmedAt: new Date("2026-11-12T12:00:00.000Z"),
  actorUserId: " operador-1 ",
  teamContext: " Patrimônio ",
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceServiceOrderConfirmer["confirm"]>>) {
  const confirmer: MaintenanceServiceOrderConfirmer = {
    confirm: vi.fn().mockResolvedValue(result)
  };

  return { confirmer, useCase: new ConfirmMaintenanceServiceOrder(confirmer) };
}

describe("confirmação funcional da Entidade na ordem de serviço", () => {
  it("normaliza os dados e propaga uma confirmação bem-sucedida", async () => {
    const confirmerResult = {
      ok: true as const,
      serviceOrderId: "service-order-1",
      status: "EXECUTADA" as const,
      confirmationId: "confirmation-1"
    };
    const { confirmer, useCase } = createUseCase(confirmerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(confirmerResult);

    expect(confirmer.confirm).toHaveBeenCalledWith({
      commandId: "command-1",
      serviceOrderId: "service-order-1",
      evidenceReference: "termo-entidade-1",
      confirmedAt: baseInput.confirmedAt,
      actorUserId: "operador-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });
  });

  it("usa a data atual e o commandId como correlationId quando omitidos", async () => {
    const now = new Date("2026-11-12T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { confirmer, useCase } = createUseCase({
        ok: true,
        serviceOrderId: "service-order-1",
        status: "EXECUTADA",
        confirmationId: "confirmation-1"
      });

      await useCase.execute({ ...baseInput, confirmedAt: undefined, correlationId: "   " });

      expect(confirmer.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ confirmedAt: now, correlationId: "command-1" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["identificador do comando", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["identificador da ordem de serviço", { serviceOrderId: " " }, "INVALID_SERVICE_ORDER_ID"],
    ["referência da evidência", { evidenceReference: " \t " }, "INVALID_EVIDENCE_REFERENCE"],
    ["data", { confirmedAt: new Date("invalid") }, "INVALID_CONFIRMED_AT"],
    ["operador", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["contexto em branco", { teamContext: " " }, "INVALID_TEAM_CONTEXT"],
    ["contexto diferente de Patrimônio", { teamContext: "Manutenção" }, "INVALID_TEAM_CONTEXT"]
  ])("rejeita %s antes de chamar o port", async (_field, override, reason) => {
    const { confirmer, useCase } = createUseCase({
      ok: true,
      serviceOrderId: "unused",
      status: "EXECUTADA",
      confirmationId: "unused"
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(confirmer.confirm).not.toHaveBeenCalled();
  });

  it.each([
    [
      "conflito de idempotência",
      {
        ok: false as const,
        reason: "IDEMPOTENCY_KEY_CONFLICT" as const,
        serviceOrderId: "service-order-1"
      }
    ],
    [
      "ordem de serviço não confirmável",
      {
        ok: false as const,
        reason: "SERVICE_ORDER_NOT_CONFIRMABLE" as const,
        serviceOrderId: "service-order-1"
      }
    ],
    [
      "operador não autorizado",
      {
        ok: false as const,
        reason: "ACTOR_NOT_AUTHORIZED" as const,
        serviceOrderId: "service-order-1"
      }
    ]
  ])("propaga a falha do port: %s", async (_label, confirmerResult) => {
    const { confirmer, useCase } = createUseCase(confirmerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(confirmerResult);
    expect(confirmer.confirm).toHaveBeenCalledOnce();
  });
});
