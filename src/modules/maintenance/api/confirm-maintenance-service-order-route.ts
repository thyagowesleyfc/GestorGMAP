import { NextResponse } from "next/server";

import type { ConfirmMaintenanceServiceOrder } from "../application/confirm-maintenance-service-order";
import type { ResolveAuthenticatedSession } from "../../organization/application/resolve-authenticated-session";
import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../../organization/infrastructure/session/session-cookie";
import { rejectCrossOriginMutation } from "../../organization/api/csrf-protection";
import { readSessionTokenFromCookie } from "../../organization/api/session-cookie-reader";

export type ConfirmMaintenanceServiceOrderRouteDependencies = {
  resolveSession: Pick<ResolveAuthenticatedSession, "execute">;
  confirmServiceOrder: Pick<ConfirmMaintenanceServiceOrder, "execute">;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

export type ConfirmMaintenanceServiceOrderRouteInput = {
  serviceOrderId: string;
  correlationId: string;
};

type ResolvedConfirmationBody = {
  commandId: string;
  evidenceReference: string;
  confirmedAt?: Date;
};

function jsonError(message: string, status: number, reasonCode?: string): NextResponse {
  return NextResponse.json(
    {
      error: message,
      ...(reasonCode === undefined ? {} : { reason_code: reasonCode })
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: Request): Promise<ResolvedConfirmationBody | null> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  const commandId = body.commandId;
  const evidenceReference = body.evidenceReference;
  const confirmedAt = body.confirmedAt;

  if (typeof commandId !== "string" || typeof evidenceReference !== "string") {
    return null;
  }

  if (confirmedAt !== undefined && typeof confirmedAt !== "string") {
    return null;
  }

  return {
    commandId,
    evidenceReference,
    ...(confirmedAt === undefined ? {} : { confirmedAt: new Date(confirmedAt) })
  };
}

function unauthenticatedResponse(environment?: RuntimeEnvironment): NextResponse {
  const response = jsonError("Sessão não autenticada.", 401);
  response.cookies.set(buildExpiredSessionCookie({ environment }));
  return response;
}

function resultStatus(reason: string): number {
  if (reason === "ACTOR_NOT_AUTHORIZED") {
    return 403;
  }

  if (reason === "SERVICE_ORDER_NOT_FOUND") {
    return 404;
  }

  if (
    reason === "IDEMPOTENCY_KEY_CONFLICT" ||
    reason === "SERVICE_ORDER_NOT_CONFIRMABLE" ||
    reason === "SERVICE_ORDER_ALREADY_CONFIRMED"
  ) {
    return 409;
  }

  return 400;
}

export async function handleConfirmMaintenanceServiceOrderRequest(
  request: Request,
  input: ConfirmMaintenanceServiceOrderRouteInput,
  dependencies: ConfirmMaintenanceServiceOrderRouteDependencies
): Promise<NextResponse> {
  const csrfResponse = rejectCrossOriginMutation(request);

  if (csrfResponse !== null) {
    return csrfResponse;
  }

  const sessionToken = readSessionTokenFromCookie(request.headers);

  if (sessionToken === null) {
    return unauthenticatedResponse(dependencies.environment);
  }

  const now = dependencies.now?.() ?? new Date();
  const resolvedSession = await dependencies.resolveSession.execute({
    sessionToken,
    now
  });

  if (resolvedSession === null) {
    return unauthenticatedResponse(dependencies.environment);
  }

  const body = await readRequestBody(request);

  if (body === null) {
    return jsonError("Informe commandId e evidenceReference válidos.", 400);
  }

  const result = await dependencies.confirmServiceOrder.execute({
    commandId: body.commandId,
    serviceOrderId: input.serviceOrderId,
    evidenceReference: body.evidenceReference,
    confirmedAt: body.confirmedAt,
    actorUserId: resolvedSession.user.id,
    teamContext: "Patrimônio",
    correlationId: input.correlationId
  });

  if (!result.ok) {
    return jsonError(
      "Não foi possível confirmar o atendimento da Ordem de Serviço.",
      resultStatus(result.reason),
      result.reason
    );
  }

  return NextResponse.json(
    {
      ok: true,
      service_order_id: result.serviceOrderId,
      confirmation_id: result.confirmationId,
      status: result.status
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
}
