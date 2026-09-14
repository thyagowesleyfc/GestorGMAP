export type LoginRateLimitIdentity = {
  loginIdentifier?: string;
  ipAddress?: string;
};

export type LoginRateLimitAllowed = {
  allowed: true;
  remainingAttempts: number;
  resetAt: Date;
};

export type LoginRateLimitBlocked = {
  allowed: false;
  retryAfterSeconds: number;
  resetAt: Date;
};

export type LoginRateLimitDecision = LoginRateLimitAllowed | LoginRateLimitBlocked;

export type LoginRateLimiter = {
  consume(identity: LoginRateLimitIdentity, now?: Date): LoginRateLimitDecision;
  reset(identity: LoginRateLimitIdentity): void;
};
