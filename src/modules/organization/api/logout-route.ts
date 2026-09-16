import { NextResponse } from "next/server";

import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";
import { rejectCrossOriginMutation } from "./csrf-protection";
import type { IamSecurityAuditLogger } from "./iam-security-audit";
import { readSessionTokenFromCookie } from "./session-cookie-reader";

export type SessionRevoker = {
  revokeByToken(token: string, revokedAt?: Date): Promise<number>;
};

export type LogoutRouteDependencies = {
  sessions: SessionRevoker;
  environment?: RuntimeEnvironment;
  now?: () => Date;
  audit?: IamSecurityAuditLogger;
};

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

export async function handleLogoutRequest(
  request: Request,
  dependencies: LogoutRouteDependencies
): Promise<NextResponse> {
  const csrfResponse = rejectCrossOriginMutation(request);

  if (csrfResponse !== null) {
    return csrfResponse;
  }

  const sessionToken = readSessionTokenFromCookie(request.headers);
  const now = dependencies.now?.() ?? new Date();
  const ipAddress = getClientIp(request.headers);

  if (sessionToken !== null) {
    await dependencies.sessions.revokeByToken(sessionToken, now);
  }

  dependencies.audit?.log("iam.logout.succeeded", {
    had_session_cookie: sessionToken !== null,
    ip_address: ipAddress ?? null
  });

  const response = NextResponse.json(
    {
      ok: true
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
  const cookie = buildExpiredSessionCookie({ environment: dependencies.environment });

  response.cookies.set(cookie);

  return response;
}
