import { describe, expect, it, vi } from "vitest";

import type { ConfirmMaintenanceServiceOrder } from "../../../src/modules/maintenance/application/confirm-maintenance-service-order";
import { handleConfirmMaintenanceServiceOrderRequest } from "../../../src/modules/maintenance/api/confirm-maintenance-service-order-route";
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
  return new Request("http://localhost/api/maintenance/service-orders/os-1/entity-confirmation", {
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
  result: Awaited<ReturnType<ConfirmMaintenanceServiceOrder["execute"]>> = {
    ok: true,
    serviceOrderId: "os-1",
    confirmationId: "confirmation-1",
    status: "EXECUTADA"
  }
) {
  return {
    now: () => new Date("2026-11-13T12:00:00.000Z"),
    resolveSession: {
      execute: vi.fn<ResolveAuthenticatedSession["execute"]>().mockResolvedValue(resolvedSession)
    },
    confirmServiceOrder: {
      execute: vi.fn<ConfirmMaintenanceServiceOrder["execute"]>().mockResolvedValue(result)
    }
  };
}

describe("handleConfirmMaintenanceServiceOrderRequest", () => {
  it("confirms using the authenticated operator and server-side team context", async () => {
    const dependencies = makeDependencies();

    const response = await handleConfirmMaintenanceServiceOrderRequest(
      request({
        commandId: " cmd-confirm-001 ",
        evidenceReference: " termo-001 ",
        confirmedAt: "2026-11-13T10:00:00.000Z"
      }),
      {
        serviceOrderId: " os-1 ",
        correlationId: "corr-confirm-001"
      },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service_order_id: "os-1",
      confirmation_id: "confirmation-1",
      status: "EXECUTADA"
    });
    expect(response.status).toBe(200);
    expect(dependencies.confirmServiceOrder.execute).toHaveBeenCalledWith({
      commandId: " cmd-confirm-001 ",
      serviceOrderId: " os-1 ",
      evidenceReference: " termo-001 ",
      confirmedAt: new Date("2026-11-13T10:00:00.000Z"),
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "corr-confirm-001"
    });
  });

  it("rejects an invalid JSON contract before calling the Command", async () => {
    const dependencies = makeDependencies();
    const invalidRequest = new Request(
      "http://localhost/api/maintenance/service-orders/os-1/entity-confirmation",
      {
        body: "não é json",
        headers: {
          cookie: "gmap_session=raw-session-token",
          "content-type": "application/json"
        },
        method: "POST"
      }
    );

    const response = await handleConfirmMaintenanceServiceOrderRequest(
      invalidRequest,
      { serviceOrderId: "os-1", correlationId: "corr-invalid" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Informe commandId e evidenceReference válidos."
    });
    expect(response.status).toBe(400);
    expect(dependencies.confirmServiceOrder.execute).not.toHaveBeenCalled();
  });

  it("returns 401 without a session and expires the cookie", async () => {
    const dependencies = makeDependencies();
    const response = await handleConfirmMaintenanceServiceOrderRequest(
      new Request("http://localhost/api/maintenance/service-orders/os-1/entity-confirmation", {
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

  it("rejects a cross-origin mutation before resolving the session", async () => {
    const dependencies = makeDependencies();
    const response = await handleConfirmMaintenanceServiceOrderRequest(
      request(
        { commandId: "cmd-1", evidenceReference: "evidence-1" },
        {
          origin: "https://evil.example"
        }
      ),
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
    ["SERVICE_ORDER_NOT_CONFIRMABLE", 409],
    ["SERVICE_ORDER_ALREADY_CONFIRMED", 409],
    ["IDEMPOTENCY_KEY_CONFLICT", 409]
  ] as const)("maps %s to HTTP %d", async (reason, status) => {
    const dependencies = makeDependencies({
      ok: false,
      reason,
      serviceOrderId: "os-1"
    });

    const response = await handleConfirmMaintenanceServiceOrderRequest(
      request({ commandId: "cmd-1", evidenceReference: "evidence-1" }),
      { serviceOrderId: "os-1", correlationId: "corr-result" },
      dependencies
    );

    await expect(response.json()).resolves.toEqual({
      error: "Não foi possível confirmar o atendimento da Ordem de Serviço.",
      reason_code: reason
    });
    expect(response.status).toBe(status);
  });
});
