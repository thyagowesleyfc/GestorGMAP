import { NextResponse } from "next/server";

import {
  buildExpiredSessionCookie,
  SESSION_COOKIE_NAME,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";

export type SessionRevoker = {
  revokeByToken(token: string, revokedAt?: Date): Promise<number>;
};

export type LogoutRouteDependencies = {
  sessions: SessionRevoker;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

function readSessionTokenFromCookie(headers: Headers): string | null {
  const cookieHeader = headers.get("cookie");

  if (cookieHeader === null) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const name = cookie.slice(0, separatorIndex).trim();

    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }

    const value = cookie.slice(separatorIndex + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }

  return null;
}

export async function handleLogoutRequest(
  request: Request,
  dependencies: LogoutRouteDependencies
): Promise<NextResponse> {
  const sessionToken = readSessionTokenFromCookie(request.headers);
  const now = dependencies.now?.() ?? new Date();

  if (sessionToken !== null) {
    await dependencies.sessions.revokeByToken(sessionToken, now);
  }

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
