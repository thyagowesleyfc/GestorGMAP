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
  get?: OpenApiOperation;
  post?: OpenApiOperation;
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

describe("OpenAPI contract", () => {
  it("uses OpenAPI 3.1 and documents implemented endpoints", () => {
    const document = readOpenApiDocument();

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/auth/login",
      "/api/health",
      "/api/ready"
    ]);
  });

  it("defines schemas for health, readiness, login and error payloads", () => {
    const document = readOpenApiDocument();

    expect(document.components.schemas).toHaveProperty("HealthPayload");
    expect(document.components.schemas).toHaveProperty("ReadinessPayload");
    expect(document.components.schemas).toHaveProperty("HealthStatus");
    expect(document.components.schemas).toHaveProperty("LoginRequest");
    expect(document.components.schemas).toHaveProperty("LoginSuccessPayload");
    expect(document.components.schemas).toHaveProperty("SimpleErrorPayload");
    expect(document.components.schemas).toHaveProperty("ErrorPayload");
  });

  it("documents the correlation id response header", () => {
    const document = readOpenApiDocument();

    expect(document.components.headers).toHaveProperty("CorrelationId");
    expect(document.paths["/api/health"].get?.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/health"].get?.responses["500"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/ready"].get?.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/ready"].get?.responses["503"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/ready"].get?.responses["500"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/login"].post?.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/login"].post?.responses["401"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/login"].post?.responses["429"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
  });

  it("documents login cookie and retry headers without exposing the session token schema", () => {
    const document = readOpenApiDocument();
    const loginResponses = document.paths["/api/auth/login"].post?.responses;

    expect(document.components.headers).toHaveProperty("SessionCookie");
    expect(document.components.headers).toHaveProperty("RetryAfter");
    expect(loginResponses?.["200"].headers).toHaveProperty("Set-Cookie");
    expect(loginResponses?.["429"].headers).toHaveProperty("Retry-After");
    expect(JSON.stringify(document.components.schemas.LoginSuccessPayload)).not.toContain("token");
    expect(JSON.stringify(document.components.schemas.LoginSuccessPayload)).not.toContain(
      "session_id"
    );
  });
});
