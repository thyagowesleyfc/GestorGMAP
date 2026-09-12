import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type OpenApiResponse = {
  headers?: Record<string, unknown>;
};

type OpenApiOperation = {
  responses: Record<string, OpenApiResponse>;
};

type OpenApiPath = {
  get: OpenApiOperation;
};

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, OpenApiPath>;
  components: {
    headers: Record<string, unknown>;
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

  it("defines schemas for health, readiness and generic error payloads", () => {
    const document = readOpenApiDocument();

    expect(document.components.schemas).toHaveProperty("HealthPayload");
    expect(document.components.schemas).toHaveProperty("ReadinessPayload");
    expect(document.components.schemas).toHaveProperty("HealthStatus");
    expect(document.components.schemas).toHaveProperty("ErrorPayload");
  });

  it("documents the correlation id response header", () => {
    const document = readOpenApiDocument();

    expect(document.components.headers).toHaveProperty("CorrelationId");
    expect(document.paths["/api/health"].get.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/health"].get.responses["500"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/ready"].get.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/ready"].get.responses["503"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/ready"].get.responses["500"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
  });
});
