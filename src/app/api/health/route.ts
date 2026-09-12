import { NextResponse } from "next/server";

import { createHealthPayload } from "../../../shared/health/checks";
import { withApiObservability } from "../../../shared/observability/api";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return withApiObservability(request, "/api/health", () =>
    NextResponse.json(createHealthPayload(), {
      headers: {
        "Cache-Control": "no-store"
      }
    })
  );
}
