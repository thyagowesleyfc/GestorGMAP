import { NextResponse } from "next/server";

import type { LoginRateLimiter } from "../application/login-rate-limit";
import type { RequestPasswordRecovery } from "../application/request-password-recovery";

export type PasswordRecoveryRequestRouteDependencies = {
  requestPasswordRecovery: Pick<RequestPasswordRecovery, "execute">;
  rateLimiter: LoginRateLimiter;
  now?: () => Date;
};

type PasswordRecoveryRequestBody = {
  loginIdentifier: string;
};

const ACCEPTED_MESSAGE =
  "Se houver uma conta ativa para este identificador, a solicita\u00e7\u00e3o de recupera\u00e7\u00e3o ser\u00e1 registrada.";

function jsonError(message: string, status: number, headers?: HeadersInit): NextResponse {
  return NextResponse.json(
    {
      error: message
    },
    {
      headers: {
        "Cache-Control": "no-store",
        ...headers
      },
      status
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: Request): Promise<PasswordRecoveryRequestBody | null> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!isRecord(body) || typeof body.loginIdentifier !== "string") {
    return null;
  }

  if (body.loginIdentifier.trim().length === 0) {
    return null;
  }

  return {
    loginIdentifier: body.loginIdentifier
  };
}

function getClientIp(headers: Headers): string | undefined {
  const forwardedFor = headers.get("x-forwarded-for");

  if (forwardedFor !== null) {
    const firstForwardedAddress = forwardedFor.split(",")[0]?.trim();

    if (firstForwardedAddress) {
      return firstForwardedAddress;
    }
  }

  return headers.get("x-real-ip")?.trim() || undefined;
}

export async function handlePasswordRecoveryRequest(
  request: Request,
  dependencies: PasswordRecoveryRequestRouteDependencies
): Promise<NextResponse> {
  const body = await readRequestBody(request);

  if (body === null) {
    return jsonError("Informe o identificador de login.", 400);
  }

  const now = dependencies.now?.() ?? new Date();
  const ipAddress = getClientIp(request.headers);
  const rateLimitIdentity = {
    loginIdentifier: body.loginIdentifier,
    ipAddress
  };
  const rateLimitDecision = dependencies.rateLimiter.consume(rateLimitIdentity, now);

  if (!rateLimitDecision.allowed) {
    return jsonError(
      "Muitas solicita\u00e7\u00f5es de recupera\u00e7\u00e3o. Tente novamente mais tarde.",
      429,
      {
        "Retry-After": String(rateLimitDecision.retryAfterSeconds)
      }
    );
  }

  await dependencies.requestPasswordRecovery.execute({
    loginIdentifier: body.loginIdentifier,
    now
  });

  return NextResponse.json(
    {
      ok: true,
      message: ACCEPTED_MESSAGE
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 202
    }
  );
}
