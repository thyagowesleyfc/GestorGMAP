import { NextResponse } from "next/server";

import { createHealthPayload } from "../../../shared/health/checks";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(createHealthPayload(), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
