import { NextResponse } from "next/server";

import type { ResolveAuthenticatedSession } from "../application/resolve-authenticated-session";
import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";
import { rejectCrossOriginMutation } from "./csrf-protection";
import type { IamSecurityAuditLogger } from "./iam-security-audit";
import { readSessionTokenFromCookie } from "./session-cookie-reader";

export type UserSessionRevoker = {
  revokeActiveForUser(sessionId: string, userId: string, revokedAt?: Date): Promise<number>;
};

export type RevokeSessionRouteDependencies = {
  resolveSession: Pick<ResolveAuthenticatedSession, "execute">;
  sessions: UserSessionRevoker;
  environment?: RuntimeEnvironment;
  now?: () => Date;
  audit?: IamSecurityAuditLogger;
};

export type RevokeSessionRouteInput = {
  sessionId: string;
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

function notFoundResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "Sessao nao encontrada."
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 404
    }
  );
}

export async function handleRevokeSessionRequest(
  request: Request,
  input: RevokeSessionRouteInput,
  dependencies: RevokeSessionRouteDependencies
): Promise<NextResponse> {
  const csrfResponse = rejectCrossOriginMutation(request);

  if (csrfResponse !== null) {
    return csrfResponse;
  }
  const targetSessionId = input.sessionId.trim();
  const ipAddress = getClientIp(request.headers);

  if (!targetSessionId) {
    return notFoundResponse();
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

  const revokedCount = await dependencies.sessions.revokeActiveForUser(
    targetSessionId,
    resolvedSession.user.id,
    now
  );

  if (revokedCount === 0) {
    return notFoundResponse();
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

  dependencies.audit?.log("iam.session.revoked", {
    current_session_revoked: targetSessionId === resolvedSession.session.id,
    ip_address: ipAddress ?? null,
    target_session_id: targetSessionId,
    user_id: resolvedSession.user.id
  });

  if (targetSessionId === resolvedSession.session.id) {
    response.cookies.set(buildExpiredSessionCookie({ environment: dependencies.environment }));
  }

  return response;
}
