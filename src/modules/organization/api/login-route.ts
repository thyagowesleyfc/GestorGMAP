import { NextResponse } from "next/server";

import type { AuthenticateUser } from "../application/authenticate-user";
import type { LoginRateLimiter } from "../application/login-rate-limit";
import type { IamSecurityAuditLogger } from "./iam-security-audit";
import {
  buildSessionCookie,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";

export type LoginRouteDependencies = {
  authenticateUser: Pick<AuthenticateUser, "execute">;
  rateLimiter: LoginRateLimiter;
  environment?: RuntimeEnvironment;
  now?: () => Date;
  audit?: IamSecurityAuditLogger;
};

type LoginRequestBody = {
  loginIdentifier: string;
  password: string;
};

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

async function readLoginBody(request: Request): Promise<LoginRequestBody | null> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  const loginIdentifier = body.loginIdentifier;
  const password = body.password;

  if (typeof loginIdentifier !== "string" || typeof password !== "string") {
    return null;
  }

  if (loginIdentifier.trim().length === 0 || password.length === 0) {
    return null;
  }

  return {
    loginIdentifier,
    password
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

export async function handleLoginRequest(
  request: Request,
  dependencies: LoginRouteDependencies
): Promise<NextResponse> {
  const body = await readLoginBody(request);

  if (body === null) {
    dependencies.audit?.log("iam.login.rejected", {
      reason_code: "invalid_payload"
    });

    return jsonError("Informe identificador de login e senha.", 400);
  }

  const now = dependencies.now?.() ?? new Date();
  const ipAddress = getClientIp(request.headers);
  const rateLimitIdentity = {
    loginIdentifier: body.loginIdentifier,
    ipAddress
  };
  const rateLimitDecision = dependencies.rateLimiter.consume(rateLimitIdentity, now);

  if (!rateLimitDecision.allowed) {
    dependencies.audit?.log("iam.login.rate_limited", {
      ip_address: ipAddress ?? null,
      reason_code: "rate_limited"
    });

    return jsonError("Muitas tentativas de login. Tente novamente mais tarde.", 429, {
      "Retry-After": String(rateLimitDecision.retryAfterSeconds)
    });
  }

  const result = await dependencies.authenticateUser.execute({
    loginIdentifier: body.loginIdentifier,
    password: body.password,
    userAgent: request.headers.get("user-agent") ?? undefined,
    ipAddress,
    now
  });

  if (!result.ok) {
    dependencies.audit?.log("iam.login.failed", {
      ip_address: ipAddress ?? null,
      reason_code: result.reason
    });

    return jsonError("Credenciais inv\u00e1lidas.", 401);
  }

  dependencies.rateLimiter.reset(rateLimitIdentity);
  dependencies.audit?.log("iam.login.succeeded", {
    ip_address: ipAddress ?? null,
    user_agent: request.headers.get("user-agent") ?? null,
    user_id: result.userId
  });

  const response = NextResponse.json(
    {
      ok: true,
      expires_at: result.expiresAt.toISOString()
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
  const cookie = buildSessionCookie({
    token: result.sessionToken,
    expiresAt: result.expiresAt,
    now,
    environment: dependencies.environment
  });

  response.cookies.set(cookie);

  return response;
}
