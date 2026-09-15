import { NextResponse } from "next/server";

import type { LoginRateLimiter } from "../application/login-rate-limit";
import type { ResetPasswordWithRecoveryToken } from "../application/reset-password-with-recovery-token";

export type PasswordRecoveryResetRouteDependencies = {
  resetPasswordWithRecoveryToken: Pick<ResetPasswordWithRecoveryToken, "execute">;
  rateLimiter: LoginRateLimiter;
  now?: () => Date;
};

type PasswordRecoveryResetBody = {
  token: string;
  newPassword: string;
};

const RESET_SUCCESS_MESSAGE = "Senha atualizada com sucesso.";
const RESET_FAILURE_MESSAGE =
  "N\u00e3o foi poss\u00edvel atualizar a senha com os dados informados.";

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

async function readResetBody(request: Request): Promise<PasswordRecoveryResetBody | null> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  const token = body.token;
  const newPassword = body.newPassword;

  if (typeof token !== "string" || typeof newPassword !== "string") {
    return null;
  }

  if (token.trim().length === 0 || newPassword.length === 0) {
    return null;
  }

  return {
    token,
    newPassword
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

export async function handlePasswordRecoveryResetRequest(
  request: Request,
  dependencies: PasswordRecoveryResetRouteDependencies
): Promise<NextResponse> {
  const body = await readResetBody(request);

  if (body === null) {
    return jsonError(RESET_FAILURE_MESSAGE, 400);
  }

  const now = dependencies.now?.() ?? new Date();
  const ipAddress = getClientIp(request.headers) ?? "unknown";
  const rateLimitDecision = dependencies.rateLimiter.consume({ ipAddress }, now);

  if (!rateLimitDecision.allowed) {
    return jsonError(
      "Muitas tentativas de recupera\u00e7\u00e3o. Tente novamente mais tarde.",
      429,
      {
        "Retry-After": String(rateLimitDecision.retryAfterSeconds)
      }
    );
  }

  const result = await dependencies.resetPasswordWithRecoveryToken.execute({
    token: body.token,
    newPassword: body.newPassword,
    now
  });

  if (!result.ok) {
    return jsonError(RESET_FAILURE_MESSAGE, 400);
  }

  return NextResponse.json(
    {
      ok: true,
      message: RESET_SUCCESS_MESSAGE
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
}
