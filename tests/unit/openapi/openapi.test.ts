import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
  };
};

function readOpenApiDocument(): OpenApiDocument {
  const path = join(process.cwd(), "docs", "openapi", "openapi.json");
  return JSON.parse(readFileSync(path, "utf8")) as OpenApiDocument;
}

describe("OpenAPI baseline", () => {
  it("uses OpenAPI 3.1 and documents only implemented initial endpoints", () => {
    const document = readOpenApiDocument();

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual(["/api/health", "/api/ready"]);
  });

  it("defines schemas for health and readiness payloads", () => {
    const document = readOpenApiDocument();

    expect(document.components.schemas).toHaveProperty("HealthPayload");
    expect(document.components.schemas).toHaveProperty("ReadinessPayload");
    expect(document.components.schemas).toHaveProperty("HealthStatus");
  });
});
