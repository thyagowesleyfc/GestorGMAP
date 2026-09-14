export const SESSION_COOKIE_NAME = "gmap_session";

export type RuntimeEnvironment = "development" | "test" | "production" | (string & {});

export type SessionCookie = {
  name: typeof SESSION_COOKIE_NAME;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  expires: Date;
  maxAge: number;
};

type SessionCookieInput = {
  token: string;
  expiresAt: Date;
  now?: Date;
  environment?: RuntimeEnvironment;
};

type ExpiredSessionCookieInput = {
  environment?: RuntimeEnvironment;
};

function usesSecureCookie(environment: RuntimeEnvironment): boolean {
  return environment !== "development" && environment !== "test";
}

function resolveEnvironment(environment: RuntimeEnvironment | undefined): RuntimeEnvironment {
  return environment ?? (process.env.NODE_ENV as RuntimeEnvironment | undefined) ?? "development";
}

function maxAgeSeconds(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}

export function buildSessionCookie(input: SessionCookieInput): SessionCookie {
  if (input.token.trim().length === 0) {
    throw new Error("Session cookie token must not be blank");
  }

  const environment = resolveEnvironment(input.environment);

  return {
    name: SESSION_COOKIE_NAME,
    value: input.token,
    httpOnly: true,
    secure: usesSecureCookie(environment),
    sameSite: "lax",
    path: "/",
    expires: input.expiresAt,
    maxAge: maxAgeSeconds(input.expiresAt, input.now ?? new Date())
  };
}

export function buildExpiredSessionCookie(input: ExpiredSessionCookieInput = {}): SessionCookie {
  const environment = resolveEnvironment(input.environment);

  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: usesSecureCookie(environment),
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0
  };
}
