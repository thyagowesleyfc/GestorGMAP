import { NextResponse } from "next/server";

const CSRF_ERROR_MESSAGE = "Origem da requisi\u00e7\u00e3o n\u00e3o permitida.";

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function headerOriginMatchesRequest(
  headers: Headers,
  headerName: "origin" | "referer",
  requestOrigin: string
): boolean {
  const value = headers.get(headerName);

  if (value === null) {
    return true;
  }

  return parseOrigin(value) === requestOrigin;
}

export function isSameOriginMutationRequest(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;

  return (
    headerOriginMatchesRequest(request.headers, "origin", requestOrigin) &&
    headerOriginMatchesRequest(request.headers, "referer", requestOrigin)
  );
}

export function forbiddenCsrfResponse(): NextResponse {
  return NextResponse.json(
    {
      error: CSRF_ERROR_MESSAGE
    },
    {
      headers: {
        "Cache-Control": "no-store"
      },
      status: 403
    }
  );
}

export function rejectCrossOriginMutation(request: Request): NextResponse | null {
  return isSameOriginMutationRequest(request) ? null : forbiddenCsrfResponse();
}
