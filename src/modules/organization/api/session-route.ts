import { NextResponse } from "next/server";

import type { ResolveAuthenticatedSession } from "../application/resolve-authenticated-session";
import type { BusinessScope } from "../domain/iam";
import {
  buildExpiredSessionCookie,
  type RuntimeEnvironment
} from "../infrastructure/session/session-cookie";
import { readSessionTokenFromCookie } from "./session-cookie-reader";

export type SessionRouteDependencies = {
  resolveSession: Pick<ResolveAuthenticatedSession, "execute">;
  environment?: RuntimeEnvironment;
  now?: () => Date;
};

type SessionScopePayload =
  | {
      type: "GLOBAL";
    }
  | {
      type: "GRE";
      gre_code: string;
    };

function toScopePayload(scope: BusinessScope): SessionScopePayload {
  if (scope.type === "GLOBAL") {
    return { type: "GLOBAL" };
  }

  return {
    type: "GRE",
    gre_code: scope.greCode
  };
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

export async function handleSessionRequest(
  request: Request,
  dependencies: SessionRouteDependencies
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

  return NextResponse.json(
    {
      authenticated: true,
      user: {
        id: resolvedSession.user.id,
        person_id: resolvedSession.user.personId,
        is_technical_superuser: resolvedSession.user.isTechnicalSuperuser
      },
      memberships: resolvedSession.memberships.map((membership) => ({
        id: membership.id,
        team_id: membership.teamId,
        role: membership.role,
        scope: toScopePayload(membership.scope)
      })),
      session: {
        expires_at: resolvedSession.session.expiresAt.toISOString()
      }
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 200
    }
  );
}
