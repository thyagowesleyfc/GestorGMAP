import { SESSION_COOKIE_NAME } from "../infrastructure/session/session-cookie";

export function readSessionTokenFromCookie(headers: Headers): string | null {
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

    if (!value) {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  return null;
}
