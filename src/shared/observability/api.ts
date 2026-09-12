import { NextResponse } from "next/server";

import { CORRELATION_ID_HEADER, resolveCorrelationId } from "./correlation";
import { logStructured } from "./logger";

type ObservedApiHandler = (context: {
  correlationId: string;
  request: Request;
}) => NextResponse | Promise<NextResponse>;

function elapsedMilliseconds(startedAt: number): number {
  return Date.now() - startedAt;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function withApiObservability(
  request: Request,
  path: string,
  handler: ObservedApiHandler
): Promise<NextResponse> {
  const startedAt = Date.now();
  const correlationId = resolveCorrelationId(request.headers);

  try {
    const response = await handler({ correlationId, request });
    response.headers.set(CORRELATION_ID_HEADER, correlationId);

    logStructured("info", "api_request_completed", "API request completed.", {
      correlation_id: correlationId,
      duration_ms: elapsedMilliseconds(startedAt),
      method: request.method,
      path,
      status: response.status
    });

    return response;
  } catch (error) {
    logStructured("error", "api_request_failed", "API request failed.", {
      correlation_id: correlationId,
      duration_ms: elapsedMilliseconds(startedAt),
      error_name: errorName(error),
      method: request.method,
      path,
      status: 500
    });

    return NextResponse.json(
      {
        error: "Erro interno do servidor.",
        correlation_id: correlationId
      },
      {
        headers: {
          "Cache-Control": "no-store",
          [CORRELATION_ID_HEADER]: correlationId
        },
        status: 500
      }
    );
  }
}
