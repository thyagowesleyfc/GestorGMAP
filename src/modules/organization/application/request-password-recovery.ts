import { normalizeLoginIdentifier } from "../domain/login-identifier";
import type { UserStatus } from "../domain/iam";

export type PasswordRecoveryUser = {
  id: string;
  status: UserStatus;
};

export type PasswordRecoveryUserReader = {
  findByLoginIdentifier(loginIdentifier: string): Promise<PasswordRecoveryUser | null>;
};

export type PasswordRecoveryTokenIssuer = {
  generate(): string;
  hash(token: string): string;
};

export type PasswordRecoveryRequestStore = {
  create(input: {
    userId: string;
    recoveryTokenHash: string;
    expiresAt: Date;
    now?: Date;
  }): Promise<void>;
};

export type RequestPasswordRecoveryInput = {
  loginIdentifier: string;
  now?: Date;
};

export type RequestPasswordRecoveryResult = {
  ok: true;
};

export type RequestPasswordRecoveryOptions = {
  tokenTtlMs?: number;
};

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

export class RequestPasswordRecovery {
  private readonly tokenTtlMs: number;

  constructor(
    private readonly users: PasswordRecoveryUserReader,
    private readonly requests: PasswordRecoveryRequestStore,
    private readonly tokens: PasswordRecoveryTokenIssuer,
    options: RequestPasswordRecoveryOptions = {}
  ) {
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;

    if (!Number.isInteger(this.tokenTtlMs) || this.tokenTtlMs < 1000) {
      throw new Error("Password recovery token TTL must be at least one second.");
    }
  }

  async execute(input: RequestPasswordRecoveryInput): Promise<RequestPasswordRecoveryResult> {
    const loginIdentifier = normalizeLoginIdentifier(input.loginIdentifier);
    const user = await this.users.findByLoginIdentifier(loginIdentifier);

    if (user === null || user.status !== "ACTIVE") {
      return { ok: true };
    }

    const now = input.now ?? new Date();
    const token = this.tokens.generate();

    await this.requests.create({
      userId: user.id,
      recoveryTokenHash: this.tokens.hash(token),
      expiresAt: new Date(now.getTime() + this.tokenTtlMs),
      now
    });

    return { ok: true };
  }
}
