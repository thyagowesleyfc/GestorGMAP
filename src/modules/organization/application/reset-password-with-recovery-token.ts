export type RecoveryPasswordHasher = {
  hash(password: string): Promise<string>;
};

export type RecoveryTokenHasher = {
  hash(token: string): string;
};

export type PasswordRecoveryResetStore = {
  resetPassword(input: {
    recoveryTokenHash: string;
    passwordHash: string;
    now?: Date;
  }): Promise<boolean>;
};

export type ResetPasswordWithRecoveryTokenInput = {
  token: string;
  newPassword: string;
  now?: Date;
};

export type ResetPasswordWithRecoveryTokenResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: "INVALID_OR_EXPIRED_TOKEN";
    };

export class ResetPasswordWithRecoveryToken {
  constructor(
    private readonly resets: PasswordRecoveryResetStore,
    private readonly passwordHasher: RecoveryPasswordHasher,
    private readonly tokenHasher: RecoveryTokenHasher
  ) {}

  async execute(
    input: ResetPasswordWithRecoveryTokenInput
  ): Promise<ResetPasswordWithRecoveryTokenResult> {
    const recoveryTokenHash = this.tokenHasher.hash(input.token);
    let passwordHash: string;

    try {
      passwordHash = await this.passwordHasher.hash(input.newPassword);
    } catch {
      return { ok: false, reason: "INVALID_OR_EXPIRED_TOKEN" };
    }

    const resetApplied = await this.resets.resetPassword({
      recoveryTokenHash,
      passwordHash,
      now: input.now
    });

    return resetApplied ? { ok: true } : { ok: false, reason: "INVALID_OR_EXPIRED_TOKEN" };
  }
}
