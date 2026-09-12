import { describe, expect, it } from "vitest";

import {
  CORRELATION_ID_HEADER,
  normalizeCorrelationId,
  resolveCorrelationId,
  withCorrelationHeader
} from "../../../src/shared/observability/correlation";

describe("correlation id", () => {
  it("accepts a safe incoming correlation id", () => {
    expect(normalizeCorrelationId(" request-123 ")).toBe("request-123");
  });

  it("rejects empty, unsafe or too long values", () => {
    expect(normalizeCorrelationId(" ")).toBeNull();
    expect(normalizeCorrelationId("id com espaco")).toBeNull();
    expect(normalizeCorrelationId("a".repeat(129))).toBeNull();
  });

  it("resolves the incoming header when present", () => {
    const headers = new Headers({ [CORRELATION_ID_HEADER]: "trace-abc" });

    expect(resolveCorrelationId(headers)).toBe("trace-abc");
  });

  it("generates a uuid when the incoming header is absent", () => {
    expect(resolveCorrelationId(new Headers())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("sets the correlation id response header", () => {
    const headers = withCorrelationHeader({ "Cache-Control": "no-store" }, "trace-xyz");

    expect(headers.get(CORRELATION_ID_HEADER)).toBe("trace-xyz");
    expect(headers.get("Cache-Control")).toBe("no-store");
  });
});
