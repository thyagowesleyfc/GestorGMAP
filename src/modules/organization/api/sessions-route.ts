import { NextResponse } from "next/server";

import type { ResolveAuthenticatedSession } from "../application/resolve-authenticated-session";
import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";
import type { SessionRecord } from "../infrastructure/session/prisma-session-store";
import { readSessionTokenFromCookie } from "./session-cookie-reader";

export type ActiveSessionsLister = {
  listActiveForUser(userId: string, now?: Date): Promise<SessionRecord[]>;
};

export type SessionsRouteDependencies = {
  resolveSession: Pick<ResolveAuthenticatedSession, "execute">;
  sessions: ActiveSessionsLister;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

function unauthenticatedResponse(environment?: RuntimeEnvironment): NextResponse {
  const response = NextResponse.json(
    {
      error: "Sessao nao autenticada."
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 401
    }
  );

  response.cookies.set(buildExpiredSessionCookie({ environment }));

  return response;
}

export async function handleSessionsRequest(
  request: Request,
  dependencies: SessionsRouteDependencies
): Promise<NextResponse> {
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

  const sessions = await dependencies.sessions.listActiveForUser(resolvedSession.user.id, now);

  return NextResponse.json(
    {
      sessions: sessions.map((session) => ({
        id: session.id,
        current: session.id === resolvedSession.session.id,
        user_agent: session.userAgent,
        ip_address: session.ipAddress,
        expires_at: session.expiresAt.toISOString(),
        last_seen_at: session.lastSeenAt.toISOString(),
        created_at: session.createdAt.toISOString()
      }))
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
}
