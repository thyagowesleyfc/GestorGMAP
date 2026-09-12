export type PasswordPolicyViolation = "TOO_SHORT" | "MISSING_LETTER" | "MISSING_NUMBER";

export type PasswordPolicyResult = {
  valid: boolean;
  violations: PasswordPolicyViolation[];
};

const MIN_PASSWORD_LENGTH = 12;

export function evaluatePasswordPolicy(password: string): PasswordPolicyResult {
  const violations: PasswordPolicyViolation[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    violations.push("TOO_SHORT");
  }

  if (!/[A-Za-z]/.test(password)) {
    violations.push("MISSING_LETTER");
  }

  if (!/[0-9]/.test(password)) {
    violations.push("MISSING_NUMBER");
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

export function assertPasswordPolicy(password: string): void {
  const result = evaluatePasswordPolicy(password);

  if (!result.valid) {
    throw new Error(`Password does not satisfy policy: ${result.violations.join(",")}`);
  }
}
