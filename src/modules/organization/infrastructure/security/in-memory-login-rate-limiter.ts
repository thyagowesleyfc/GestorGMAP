import type {
  LoginRateLimitDecision,
  LoginRateLimitIdentity,
  LoginRateLimiter
} from "../../application/login-rate-limit";

export type InMemoryLoginRateLimiterOptions = {
  maxAttempts?: number;
  windowMs?: number;
};

type AttemptBucket = {
  attempts: number;
  resetAtMs: number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function normalizeIdentityPart(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function buildIdentityKey(identity: LoginRateLimitIdentity): string {
  const loginIdentifier = normalizeIdentityPart(identity.loginIdentifier);
  const ipAddress = normalizeIdentityPart(identity.ipAddress);

  if (loginIdentifier === null && ipAddress === null) {
    throw new Error("Login rate limit identity requires login identifier or IP address.");
  }

  return `login:${loginIdentifier ?? "*"}|ip:${ipAddress ?? "*"}`;
}

function retryAfterSeconds(resetAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}

export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, AttemptBucket>();

  constructor(options: InMemoryLoginRateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("Login rate limit max attempts must be a positive integer.");
    }

    if (!Number.isInteger(this.windowMs) || this.windowMs < 1000) {
      throw new Error("Login rate limit window must be at least one second.");
    }
  }

  consume(identity: LoginRateLimitIdentity, now = new Date()): LoginRateLimitDecision {
    const key = buildIdentityKey(identity);
    const nowMs = now.getTime();
    const current = this.buckets.get(key);
    const bucket =
      current === undefined || current.resetAtMs <= nowMs
        ? {
            attempts: 0,
            resetAtMs: nowMs + this.windowMs
          }
        : current;

    if (bucket.attempts >= this.maxAttempts) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSeconds(bucket.resetAtMs, nowMs),
        resetAt: new Date(bucket.resetAtMs)
      };
    }

    bucket.attempts += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: true,
      remainingAttempts: this.maxAttempts - bucket.attempts,
      resetAt: new Date(bucket.resetAtMs)
    };
  }

  reset(identity: LoginRateLimitIdentity): void {
    this.buckets.delete(buildIdentityKey(identity));
  }
}
