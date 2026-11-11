import { describe, expect, it, vi } from "vitest";

import {
  IssueMaintenanceRequestPatrimonyReport,
  type IssueMaintenanceRequestPatrimonyReportInput,
  type MaintenanceRequestPatrimonyReportIssuer
} from "../../../src/modules/maintenance/application/issue-maintenance-request-patrimony-report";

const baseInput: IssueMaintenanceRequestPatrimonyReportInput = {
  commandId: " command-1 ",
  maintenanceRequestId: " maintenance-request-1 ",
  patrimonyId: " patrimony-1 ",
  conclusion: " recondicionavel ",
  justification: " Equipamento apto para recuperação mediante manutenção. ",
  issuedAt: new Date("2026-11-11T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " Manutenção ",
  correlationId: " correlation-1 "
};

function createUseCase(
  result: Awaited<ReturnType<MaintenanceRequestPatrimonyReportIssuer["issue"]>>
) {
  const issuer: MaintenanceRequestPatrimonyReportIssuer = {
    issue: vi.fn().mockResolvedValue(result)
  };

  return { issuer, useCase: new IssueMaintenanceRequestPatrimonyReport(issuer) };
}

describe("issue maintenance request patrimony report", () => {
  it("normalizes the emission and forwards a valid report to the infrastructure port", async () => {
    const issuerResult = {
      ok: true as const,
      reportId: "report-1",
      maintenanceRequestId: "maintenance-request-1",
      patrimonyId: "patrimony-1",
      conclusion: "RECONDICIONAVEL" as const,
      version: 1,
      status: "EM_ANALISE" as const
    };
    const { issuer, useCase } = createUseCase(issuerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(issuerResult);

    expect(issuer.issue).toHaveBeenCalledWith({
      commandId: "command-1",
      maintenanceRequestId: "maintenance-request-1",
      patrimonyId: "patrimony-1",
      conclusion: "RECONDICIONAVEL",
      justification: "Equipamento apto para recuperação mediante manutenção.",
      issuedAt: baseInput.issuedAt,
      actorUserId: "user-1",
      teamContext: "Manutenção",
      correlationId: "correlation-1"
    });
  });

  it("forwards a correction and propagates the new report version from the port", async () => {
    const issuerResult = {
      ok: true as const,
      reportId: "report-2",
      maintenanceRequestId: "maintenance-request-1",
      patrimonyId: "patrimony-1",
      conclusion: "IRRECUPERAVEL" as const,
      version: 2,
      status: "EM_ANALISE" as const
    };
    const { issuer, useCase } = createUseCase(issuerResult);

    await expect(
      useCase.execute({
        ...baseInput,
        conclusion: " irrecuperavel ",
        justification: " Correção do laudo após nova avaliação técnica. "
      })
    ).resolves.toEqual(issuerResult);

    expect(issuer.issue).toHaveBeenCalledWith({
      commandId: "command-1",
      maintenanceRequestId: "maintenance-request-1",
      patrimonyId: "patrimony-1",
      conclusion: "IRRECUPERAVEL",
      justification: "Correção do laudo após nova avaliação técnica.",
      issuedAt: baseInput.issuedAt,
      actorUserId: "user-1",
      teamContext: "Manutenção",
      correlationId: "correlation-1"
    });
  });

  it.each(["REPARAVEL", "SEM_CONCLUSAO", "BAIXA_IMEDIATA"])(
    "rejects invalid conclusion %s before issuing",
    async (conclusion) => {
      const { issuer, useCase } = createUseCase({
        ok: true,
        reportId: "unused",
        maintenanceRequestId: "unused",
        patrimonyId: "unused",
        conclusion: "INDEFINIDO",
        version: 1,
        status: "EM_ANALISE"
      });

      await expect(useCase.execute({ ...baseInput, conclusion })).resolves.toMatchObject({
        ok: false,
        reason: "INVALID_CONCLUSION",
        patrimonyId: "patrimony-1"
      });
      expect(issuer.issue).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["maintenance request", { maintenanceRequestId: " " }, "INVALID_MAINTENANCE_REQUEST_ID"],
    ["patrimony target identifier", { patrimonyId: " " }, "INVALID_PATRIMONY_ID"],
    ["justification", { justification: " \t " }, "INVALID_JUSTIFICATION"],
    ["date", { issuedAt: new Date("invalid") }, "INVALID_ISSUED_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"]
  ])(
    "rejects an invalid %s before calling the infrastructure port",
    async (_field, override, reason) => {
      const { issuer, useCase } = createUseCase({
        ok: true,
        reportId: "unused",
        maintenanceRequestId: "unused",
        patrimonyId: "unused",
        conclusion: "INDEFINIDO",
        version: 1,
        status: "EM_ANALISE"
      });

      await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
        ok: false,
        reason
      });
      expect(issuer.issue).not.toHaveBeenCalled();
    }
  );
});
