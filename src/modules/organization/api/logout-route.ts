import { NextResponse } from "next/server";

import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";
import { readSessionTokenFromCookie } from "./session-cookie-reader";

export type SessionRevoker = {
  revokeByToken(token: string, revokedAt?: Date): Promise<number>;
};

export type LogoutRouteDependencies = {
  sessions: SessionRevoker;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

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
