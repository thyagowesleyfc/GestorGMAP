import { describe, expect, it, vi } from "vitest";

import {
  IncorporatePatrimonyFromAcceptedDelivery,
  type PatrimonyIncorporator
} from "../../../src/modules/patrimony/application/incorporate-patrimony-from-delivery";

describe("incorporate patrimony from accepted delivery", () => {
  it("rejects an incomplete command before reaching persistence", async () => {
    const incorporator: PatrimonyIncorporator = {
      incorporate: vi.fn()
    };
    const useCase = new IncorporatePatrimonyFromAcceptedDelivery(incorporator);

    await expect(
      useCase.execute({
        commandId: " ",
        deliveryId: "delivery-1",
        reason: "Incorporacao",
        actorUserId: "user-1",
        teamContext: "Patrimonio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    expect(incorporator.incorporate).not.toHaveBeenCalled();
  });

  it("normalizes the command and supplies a correlation id", async () => {
    const result = {
      ok: true as const,
      deliveryId: "delivery-1",
      patrimonyIds: ["patrimony-1"],
      tombos: ["011-01-000001"]
    };
    const incorporator: PatrimonyIncorporator = {
      incorporate: vi.fn().mockResolvedValue(result)
    };
    const useCase = new IncorporatePatrimonyFromAcceptedDelivery(incorporator);

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        deliveryId: " delivery-1 ",
        reason: " Incorporacao apos aceite ",
        actorUserId: " user-1 ",
        teamContext: " Patrimonio ",
        correlationId: " correlation-1 "
      })
    ).resolves.toEqual(result);

    expect(incorporator.incorporate).toHaveBeenCalledWith({
      commandId: "command-1",
      deliveryId: "delivery-1",
      incorporatedAt: expect.any(Date),
      reason: "Incorporacao apos aceite",
      actorUserId: "user-1",
      teamContext: "Patrimonio",
      correlationId: "correlation-1"
    });
  });

  it("does not allow a partial delivery in the application contract", async () => {
    const incorporator: PatrimonyIncorporator = {
      incorporate: vi.fn().mockResolvedValue({
        ok: false,
        reason: "PARTIAL_ACCEPTANCE_NOT_SUPPORTED",
        deliveryId: "delivery-1"
      })
    };
    const useCase = new IncorporatePatrimonyFromAcceptedDelivery(incorporator);

    await expect(
      useCase.execute({
        commandId: "command-2",
        deliveryId: "delivery-1",
        reason: "Aguardar quantidade aceita",
        actorUserId: "user-1",
        teamContext: "Patrimonio"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "PARTIAL_ACCEPTANCE_NOT_SUPPORTED",
      deliveryId: "delivery-1"
    });
  });
});
