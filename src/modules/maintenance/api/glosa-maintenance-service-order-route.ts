import { NextResponse } from "next/server";

import type { GlosaMaintenanceServiceOrder } from "../application/glosa-maintenance-service-order";
import type { ResolveAuthenticatedSession } from "../../organization/application/resolve-authenticated-session";
import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../../organization/infrastructure/session/session-cookie";
import { rejectCrossOriginMutation } from "../../organization/api/csrf-protection";
import { readSessionTokenFromCookie } from "../../organization/api/session-cookie-reader";

export type GlosaMaintenanceServiceOrderRouteDependencies = {
  resolveSession: Pick<ResolveAuthenticatedSession, "execute">;
  glosaServiceOrder: Pick<GlosaMaintenanceServiceOrder, "execute">;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

export type GlosaMaintenanceServiceOrderRouteInput = {
  serviceOrderId: string;
  correlationId: string;
};

type ResolvedGlosaBody = {
  commandId: string;
  lines: Array<{
    serviceOrderServiceId: string;
    quantity: number;
  }>;
  glosaAt?: Date;
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

async function readRequestBody(request: Request): Promise<ResolvedGlosaBody | null> {
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
  const lines = body.lines;
  const glosaAt = body.glosaAt;

  if (typeof commandId !== "string" || !Array.isArray(lines)) {
    return null;
  }

  const resolvedLines: ResolvedGlosaBody["lines"] = [];
  for (const line of lines) {
    if (!isRecord(line)) {
      return null;
    }

    if (typeof line.serviceOrderServiceId !== "string" || typeof line.quantity !== "number") {
      return null;
    }

    resolvedLines.push({
      serviceOrderServiceId: line.serviceOrderServiceId,
      quantity: line.quantity
    });
  }

  if (glosaAt !== undefined && typeof glosaAt !== "string") {
    return null;
  }

  return {
    commandId,
    lines: resolvedLines,
    ...(glosaAt === undefined ? {} : { glosaAt: new Date(glosaAt) })
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
    reason === "SERVICE_ORDER_NOT_GLOSSABLE" ||
    reason === "SERVICE_ORDER_WITHOUT_ENTITY_CONFIRMATION" ||
    reason === "SERVICE_ORDER_WITHOUT_PATRIMONY_TARGET" ||
    reason === "SERVICE_ORDER_LINE_ALREADY_GLOSSED" ||
    reason === "GLOSA_QUANTITY_EXCEEDS_COMMITTED" ||
    reason === "CONTRACT_ITEM_BALANCE_NOT_FOUND" ||
    reason === "CONTRACT_ITEM_CONTRACT_MISMATCH" ||
    reason === "INSUFFICIENT_COMMITTED_CONTRACT_BALANCE"
  ) {
    return 409;
  }

  return 400;
}

export async function handleGlosaMaintenanceServiceOrderRequest(
  request: Request,
  input: GlosaMaintenanceServiceOrderRouteInput,
  dependencies: GlosaMaintenanceServiceOrderRouteDependencies
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
    return jsonError("Informe commandId, lines e glosaAt válidos.", 400);
  }

  const result = await dependencies.glosaServiceOrder.execute({
    commandId: body.commandId,
    serviceOrderId: input.serviceOrderId,
    lines: body.lines,
    glosaAt: body.glosaAt,
    actorUserId: resolvedSession.user.id,
    teamContext: "Patrimônio",
    correlationId: input.correlationId
  });

  if (!result.ok) {
    return jsonError(
      "Não foi possível registrar a glosa da Ordem de Serviço.",
      resultStatus(result.reason),
      result.reason
    );
  }

  return NextResponse.json(
    {
      ok: true,
      service_order_id: result.serviceOrderId,
      status: result.status,
      total_glosa_amount: result.totalGlosaAmount
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
}
