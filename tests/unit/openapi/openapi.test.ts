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
  delete?: OpenApiOperation;
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
      "/api/auth/logout",
      "/api/auth/password-recovery/request",
      "/api/auth/password-recovery/reset",
      "/api/auth/session",
      "/api/auth/sessions",
      "/api/auth/sessions/{sessionId}",
      "/api/health",
      "/api/ready"
    ]);
  });

  it("defines schemas for health, readiness, auth and error payloads", () => {
    const document = readOpenApiDocument();

    expect(document.components.schemas).toHaveProperty("HealthPayload");
    expect(document.components.schemas).toHaveProperty("ReadinessPayload");
    expect(document.components.schemas).toHaveProperty("HealthStatus");
    expect(document.components.schemas).toHaveProperty("LoginRequest");
    expect(document.components.schemas).toHaveProperty("LoginSuccessPayload");
    expect(document.components.schemas).toHaveProperty("PasswordRecoveryRequest");
    expect(document.components.schemas).toHaveProperty("PasswordRecoveryRequestAcceptedPayload");
    expect(document.components.schemas).toHaveProperty("PasswordRecoveryResetRequest");
    expect(document.components.schemas).toHaveProperty("PasswordRecoveryResetSuccessPayload");
    expect(document.components.schemas).toHaveProperty("AuthSessionPayload");
    expect(document.components.schemas).toHaveProperty("AuthMembership");
    expect(document.components.schemas).toHaveProperty("AuthScope");
    expect(document.components.schemas).toHaveProperty("ActiveSessionsPayload");
    expect(document.components.schemas).toHaveProperty("ActiveSessionItem");
    expect(document.components.schemas).toHaveProperty("OkPayload");
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
    expect(document.paths["/api/auth/logout"].post?.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(
      document.paths["/api/auth/password-recovery/request"].post?.responses["202"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/password-recovery/request"].post?.responses["429"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/password-recovery/reset"].post?.responses["200"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/password-recovery/reset"].post?.responses["400"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/password-recovery/reset"].post?.responses["429"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(document.paths["/api/auth/logout"].post?.responses["403"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/logout"].post?.responses["500"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/session"].get?.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/session"].get?.responses["401"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/sessions"].get?.responses["200"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(document.paths["/api/auth/sessions"].get?.responses["401"].headers).toHaveProperty(
      "X-Correlation-Id"
    );
    expect(
      document.paths["/api/auth/sessions/{sessionId}"].delete?.responses["200"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/sessions/{sessionId}"].delete?.responses["401"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/sessions/{sessionId}"].delete?.responses["403"].headers
    ).toHaveProperty("X-Correlation-Id");
    expect(
      document.paths["/api/auth/sessions/{sessionId}"].delete?.responses["404"].headers
    ).toHaveProperty("X-Correlation-Id");
  });

  it("documents auth cookie and retry headers without exposing the session token schema", () => {
    const document = readOpenApiDocument();
    const loginResponses = document.paths["/api/auth/login"].post?.responses;
    const logoutResponses = document.paths["/api/auth/logout"].post?.responses;
    const passwordRecoveryResponses =
      document.paths["/api/auth/password-recovery/request"].post?.responses;
    const passwordRecoveryResetResponses =
      document.paths["/api/auth/password-recovery/reset"].post?.responses;
    const sessionResponses = document.paths["/api/auth/session"].get?.responses;
    const sessionsResponses = document.paths["/api/auth/sessions"].get?.responses;
    const revokeSessionResponses =
      document.paths["/api/auth/sessions/{sessionId}"].delete?.responses;

    expect(document.components.headers).toHaveProperty("SessionCookie");
    expect(document.components.headers).toHaveProperty("RetryAfter");
    expect(loginResponses?.["200"].headers).toHaveProperty("Set-Cookie");
    expect(logoutResponses?.["200"].headers).toHaveProperty("Set-Cookie");
    expect(sessionResponses?.["401"].headers).toHaveProperty("Set-Cookie");
    expect(sessionsResponses?.["401"].headers).toHaveProperty("Set-Cookie");
    expect(revokeSessionResponses?.["200"].headers).toHaveProperty("Set-Cookie");
    expect(revokeSessionResponses?.["401"].headers).toHaveProperty("Set-Cookie");
    expect(loginResponses?.["429"].headers).toHaveProperty("Retry-After");
    expect(passwordRecoveryResponses?.["429"].headers).toHaveProperty("Retry-After");
    expect(passwordRecoveryResetResponses?.["429"].headers).toHaveProperty("Retry-After");
    expect(
      JSON.stringify(document.components.schemas.PasswordRecoveryRequestAcceptedPayload)
    ).not.toContain("token");
    expect(
      JSON.stringify(document.components.schemas.PasswordRecoveryResetSuccessPayload)
    ).not.toContain("token");
    expect(JSON.stringify(document.components.schemas.LoginSuccessPayload)).not.toContain("token");
    expect(JSON.stringify(document.components.schemas.LoginSuccessPayload)).not.toContain(
      "session_id"
    );
    expect(JSON.stringify(document.components.schemas.AuthSessionPayload)).not.toContain("token");
    expect(JSON.stringify(document.components.schemas.AuthSessionPayload)).not.toContain(
      "session_id"
    );
    expect(JSON.stringify(document.components.schemas.ActiveSessionsPayload)).not.toContain(
      "token"
    );
    expect(JSON.stringify(document.components.schemas.ActiveSessionsPayload)).not.toContain(
      "session_id"
    );
  });
});
