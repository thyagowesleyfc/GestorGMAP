import { describe, expect, it, vi } from "vitest";

import type { AttestMaintenanceServiceOrder } from "../../../src/modules/maintenance/application/attest-maintenance-service-order";
import { handleAttestMaintenanceServiceOrderRequest } from "../../../src/modules/maintenance/api/attest-maintenance-service-order-route";
import type { ResolveAuthenticatedSession } from "../../../src/modules/organization/application/resolve-authenticated-session";

const resolvedSession = {
  session: {
    id: "session-1",
    userId: "user-1",
    expiresAt: new Date("2026-11-13T20:00:00.000Z")
  },
  user: {
    id: "user-1",
    personId: "person-1",
    status: "ACTIVE" as const,
    isTechnicalSuperuser: false
  },
  memberships: []
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/maintenance/service-orders/os-1/attestation", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie: "gmap_session=raw-session-token",
      ...headers
    },
    method: "POST"
  });
}

function makeDependencies(
  result: Awaited<ReturnType<AttestMaintenanceServiceOrder["execute"]>> = {
    ok: true,
    serviceOrderId: "os-1",
    status: "ATESTADA"
  }
) {
  return {
    now: () => new Date("2026-11-13T12:00:00.000Z"),
    resolveSession: {
      execute: vi.fn<ResolveAuthenticatedSession["execute"]>().mockResolvedValue(resolvedSession)
    },
    attestServiceOrder: {
      execute: vi.fn<AttestMaintenanceServiceOrder["execute"]>().mockResolvedValue(result)
    }
  };
}

describe("handleAttestMaintenanceServiceOrderRequest", () => {
  it("atesta usando o operador autenticado e o contexto server-side", async () => {
    const dependencies = makeDependencies();

    const response = await handleAttestMaintenanceServiceOrderRequest(
      request({
        commandId: " command-attest-001 ",
        attestedAt: "2026-11-13T10:00:00.000Z"
      }),
      {
        serviceOrderId: " os-1 ",
        correlationId: "corr-attest-001"
      },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service_order_id: "os-1",
      status: "ATESTADA"
    });
    expect(response.status).toBe(200);
    expect(dependencies.attestServiceOrder.execute).toHaveBeenCalledWith({
      commandId: " command-attest-001 ",
      serviceOrderId: " os-1 ",
      attestedAt: new Date("2026-11-13T10:00:00.000Z"),
      actorUserId: "user-1",
      teamContext: "Patrim\u00f4nio",
      correlationId: "corr-attest-001"
    });
  });

  it("aceita attestedAt omitido e deixa o Command definir o instante", async () => {
    const dependencies = makeDependencies();

    const response = await handleAttestMaintenanceServiceOrderRequest(
      request({ commandId: "cmd-1" }),
      { serviceOrderId: "os-1", correlationId: "corr-default-date" },
      dependencies
    );

    expect(response.status).toBe(200);
    expect(dependencies.attestServiceOrder.execute).toHaveBeenCalledWith({
      commandId: "cmd-1",
      serviceOrderId: "os-1",
      attestedAt: undefined,
      actorUserId: "user-1",
      teamContext: "Patrim\u00f4nio",
      correlationId: "corr-default-date"
    });
  });

  it("retorna 400 para contrato JSON inválido antes de chamar o Command", async () => {
    const dependencies = makeDependencies();
    const invalidRequest = new Request(
      "http://localhost/api/maintenance/service-orders/os-1/attestation",
      {
        body: "não é json",
        headers: {
          cookie: "gmap_session=raw-session-token",
          "content-type": "application/json"
        },
        method: "POST"
      }
    );

    const response = await handleAttestMaintenanceServiceOrderRequest(
      invalidRequest,
      { serviceOrderId: "os-1", correlationId: "corr-invalid" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Informe commandId e attestedAt válidos."
    });
    expect(response.status).toBe(400);
    expect(dependencies.attestServiceOrder.execute).not.toHaveBeenCalled();
  });

  it("retorna 401 sem sessão e expira o cookie", async () => {
    const dependencies = makeDependencies();
    const response = await handleAttestMaintenanceServiceOrderRequest(
      new Request("http://localhost/api/maintenance/service-orders/os-1/attestation", {
        method: "POST"
      }),
      { serviceOrderId: "os-1", correlationId: "corr-unauthenticated" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Sessão não autenticada."
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(dependencies.resolveSession.execute).not.toHaveBeenCalled();
  });

  it("retorna 403 para mutação cross-origin antes de resolver a sessão", async () => {
    const dependencies = makeDependencies();
    const response = await handleAttestMaintenanceServiceOrderRequest(
      request({ commandId: "cmd-1" }, { origin: "https://evil.example" }),
      { serviceOrderId: "os-1", correlationId: "corr-csrf" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Origem da requisição não permitida."
    });
    expect(response.status).toBe(403);
    expect(dependencies.resolveSession.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["ACTOR_NOT_AUTHORIZED", 403],
    ["SERVICE_ORDER_NOT_FOUND", 404],
    ["SERVICE_ORDER_NOT_ATTESTABLE", 409],
    ["IDEMPOTENCY_KEY_CONFLICT", 409]
  ] as const)("mapeia %s para HTTP %d", async (reason, status) => {
    const dependencies = makeDependencies({
      ok: false,
      reason,
      serviceOrderId: "os-1"
    });

    const response = await handleAttestMaintenanceServiceOrderRequest(
      request({ commandId: "cmd-1" }),
      { serviceOrderId: "os-1", correlationId: "corr-result" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Não foi possível atestar a Ordem de Serviço.",
      reason_code: reason
    });
    expect(response.status).toBe(status);
  });
});
