import { describe, expect, it, vi } from "vitest";

import {
  ReplacePatrimonyUnderWarranty,
  type ReplacePatrimonyUnderWarrantyCommand
} from "../../../src/modules/patrimony/application/replace-patrimony-under-warranty";

const validInput: ReplacePatrimonyUnderWarrantyCommand = {
  commandId: "cmd-replace-1",
  patrimonyId: "patrimony-1",
  maintenanceRequestId: "maintenance-1",
  replacementMaterialSingularId: "material-2",
  warrantyReference: "GARANTIA-001",
  evidences: [{ type: "LAUDO", reference: "LAUDO-001" }],
  justification: "Substituição integral autorizada em garantia.",
  occurredAt: new Date("2026-11-13T12:00:00.000Z"),
  actorUserId: "user-1",
  teamContext: "Patrimônio",
  correlationId: "corr-1"
};

describe("ReplacePatrimonyUnderWarranty", () => {
  it.each([
    ["commandId", { commandId: "" }, "INVALID_COMMAND_ID"],
    ["patrimonyId", { patrimonyId: "" }, "INVALID_PATRIMONY_ID"],
    ["maintenanceRequestId", { maintenanceRequestId: "" }, "INVALID_MAINTENANCE_REQUEST_ID"],
    [
      "replacement material",
      { replacementMaterialSingularId: "" },
      "INVALID_REPLACEMENT_MATERIAL_ID"
    ],
    ["warranty reference", { warrantyReference: "" }, "INVALID_WARRANTY_REFERENCE"],
    ["evidence", { evidences: [] }, "INVALID_EVIDENCE"],
    ["justification", { justification: "" }, "INVALID_JUSTIFICATION"],
    ["actor", { actorUserId: "" }, "INVALID_ACTOR_USER_ID"]
  ])("rejects invalid %s before persistence", async (_field, override, reason) => {
    const replace = vi.fn();
    const useCase = new ReplacePatrimonyUnderWarranty({ replace });

    await expect(
      useCase.execute({ ...validInput, ...override } as ReplacePatrimonyUnderWarrantyCommand)
    ).resolves.toEqual({ ok: false, reason });
    expect(replace).not.toHaveBeenCalled();
  });

  it("normalizes strings and delegates the command", async () => {
    const replace = vi.fn().mockResolvedValue({
      ok: true,
      replacementId: "replacement-1",
      previousPatrimonyId: "patrimony-1",
      replacementPatrimonyId: "patrimony-2",
      replacementTombo: "011-01-000002"
    });
    const useCase = new ReplacePatrimonyUnderWarranty({ replace });

    await expect(
      useCase.execute({
        ...validInput,
        commandId: " cmd-replace-1 ",
        warrantyReference: " GARANTIA-001 ",
        serialNumber: " SERIAL-1 ",
        evidences: [{ type: "LAUDO", reference: " LAUDO-001 " }]
      })
    ).resolves.toMatchObject({ ok: true });

    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-replace-1",
        warrantyReference: "GARANTIA-001",
        serialNumber: "SERIAL-1",
        evidences: [{ type: "LAUDO", reference: "LAUDO-001" }]
      })
    );
  });
});
