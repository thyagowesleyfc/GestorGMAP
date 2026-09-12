import { randomUUID } from "node:crypto";

export const CORRELATION_ID_HEADER = "x-correlation-id";

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function normalizeCorrelationId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length > MAX_CORRELATION_ID_LENGTH) {
    return null;
  }

  if (!SAFE_CORRELATION_ID_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function resolveCorrelationId(headers: Headers): string {
  return normalizeCorrelationId(headers.get(CORRELATION_ID_HEADER)) ?? randomUUID();
}

export function withCorrelationHeader(
  headers: HeadersInit | undefined,
  correlationId: string
): Headers {
  const nextHeaders = new Headers(headers);
  nextHeaders.set(CORRELATION_ID_HEADER, correlationId);
  return nextHeaders;
}
