import { NextResponse } from "next/server";

import type { AttestMaintenanceServiceOrder } from "../application/attest-maintenance-service-order";
import type { ResolveAuthenticatedSession } from "../../organization/application/resolve-authenticated-session";
import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../../organization/infrastructure/session/session-cookie";
import { rejectCrossOriginMutation } from "../../organization/api/csrf-protection";
import { readSessionTokenFromCookie } from "../../organization/api/session-cookie-reader";

export type AttestMaintenanceServiceOrderRouteDependencies = {
  resolveSession: Pick<ResolveAuthenticatedSession, "execute">;
  attestServiceOrder: Pick<AttestMaintenanceServiceOrder, "execute">;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

export type AttestMaintenanceServiceOrderRouteInput = {
  serviceOrderId: string;
  correlationId: string;
};

type ResolvedAttestationBody = {
  commandId: string;
  attestedAt?: Date;
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

async function readRequestBody(request: Request): Promise<ResolvedAttestationBody | null> {
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
  const attestedAt = body.attestedAt;

  if (typeof commandId !== "string") {
    return null;
  }

  if (attestedAt !== undefined && typeof attestedAt !== "string") {
    return null;
  }

  return {
    commandId,
    ...(attestedAt === undefined ? {} : { attestedAt: new Date(attestedAt) })
  };
}

function unauthenticatedResponse(environment?: RuntimeEnvironment): NextResponse {
  const response = jsonError("Sess\u00e3o n\u00e3o autenticada.", 401);
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

  if (reason === "IDEMPOTENCY_KEY_CONFLICT" || reason === "SERVICE_ORDER_NOT_ATTESTABLE") {
    return 409;
  }

  return 400;
}

export async function handleAttestMaintenanceServiceOrderRequest(
  request: Request,
  input: AttestMaintenanceServiceOrderRouteInput,
  dependencies: AttestMaintenanceServiceOrderRouteDependencies
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
    return jsonError("Informe commandId e attestedAt v\u00e1lidos.", 400);
  }

  const result = await dependencies.attestServiceOrder.execute({
    commandId: body.commandId,
    serviceOrderId: input.serviceOrderId,
    attestedAt: body.attestedAt,
    actorUserId: resolvedSession.user.id,
    teamContext: "Patrim\u00f4nio",
    correlationId: input.correlationId
  });

  if (!result.ok) {
    return jsonError(
      "N\u00e3o foi poss\u00edvel atestar a Ordem de Servi\u00e7o.",
      resultStatus(result.reason),
      result.reason
    );
  }

  return NextResponse.json(
    {
      ok: true,
      service_order_id: result.serviceOrderId,
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
