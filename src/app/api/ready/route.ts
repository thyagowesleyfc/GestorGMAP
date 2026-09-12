import { NextResponse } from "next/server";

import { createReadinessPayload } from "../../../shared/health/checks";
import { withApiObservability } from "../../../shared/observability/api";
import { prisma } from "../../../shared/prisma/client";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return withApiObservability(request, "/api/ready", async () => {
    const result = await createReadinessPayload(() => prisma.$queryRaw`SELECT 1`);

    return NextResponse.json(result.payload, {
      headers: {
        "Cache-Control": "no-store"
      },
      status: result.httpStatus
    });
  });
}
