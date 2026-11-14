import { describe, expect, it, vi } from "vitest";

import {
  ReplacePatrimonialComponent,
  type ReplacePatrimonialComponentInput
} from "../../../src/modules/patrimony/application/replace-patrimonial-component";

const validInput: ReplacePatrimonialComponentInput = {
  commandId: "cmd-component-1",
  patrimonyId: "patrimony-1",
  maintenanceRequestId: "maintenance-1",
  compositionItemId: "composition-item-1",
  expectedRevision: 1,
  replacementMaterialSingularId: "material-2",
  replacementSerialNumber: "SERIAL-2",
  evidences: [{ type: "LAUDO", reference: "LAUDO-1" }],
  justification: "Substituição de componente em manutenção.",
  occurredAt: new Date("2026-11-13T12:00:00.000Z"),
  actorUserId: "user-1",
  teamContext: "Patrimônio",
  correlationId: "corr-1"
};

describe("ReplacePatrimonialComponent", () => {
  it.each([
    ["commandId", { commandId: "" }, "INVALID_COMMAND_ID"],
    ["composition item", { compositionItemId: "" }, "INVALID_COMPOSITION_ITEM_ID"],
    ["revision", { expectedRevision: 0 }, "INVALID_EXPECTED_REVISION"],
    [
      "replacement material",
      { replacementMaterialSingularId: "" },
      "INVALID_REPLACEMENT_MATERIAL_ID"
    ],
    ["replacement Tombo", { replacementTombo: "011-01-000099" }, "REPLACEMENT_TOMBO_NOT_ALLOWED"],
    ["justification", { justification: "" }, "INVALID_JUSTIFICATION"],
    ["evidence", { evidences: [{ type: "OUTRO", reference: " " }] }, "INVALID_EVIDENCE"]
  ])("rejects invalid %s before persistence", async (_field, override, reason) => {
    const replace = vi.fn();
    const useCase = new ReplacePatrimonialComponent({ replace });

    await expect(
      useCase.execute({ ...validInput, ...override } as ReplacePatrimonialComponentInput)
    ).resolves.toEqual({ ok: false, reason });
    expect(replace).not.toHaveBeenCalled();
  });

  it("normalizes optional data and delegates the command", async () => {
    const replace = vi.fn().mockResolvedValue({
      ok: true,
      replacementId: "replacement-1",
      patrimonyId: "patrimony-1",
      previousCompositionId: "composition-1",
      replacementCompositionId: "composition-2",
      previousRevision: 1,
      replacementRevision: 2,
      previousComponentPatrimonyId: "component-1",
      replacementComponentPatrimonyId: "component-2",
      replacementTombo: "011-01-000002"
    });
    const useCase = new ReplacePatrimonialComponent({ replace });

    await expect(
      useCase.execute({
        ...validInput,
        replacementSerialNumber: " SERIAL-2 ",
        evidences: [{ type: "LAUDO", reference: " LAUDO-1 " }]
      })
    ).resolves.toMatchObject({ ok: true });

    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        replacementSerialNumber: "SERIAL-2",
        evidences: [{ type: "LAUDO", reference: "LAUDO-1" }]
      })
    );
  });
});
