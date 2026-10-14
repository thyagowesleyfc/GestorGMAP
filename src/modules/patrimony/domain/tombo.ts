const MAX_TOMBO_LENGTH = 64;
const TOMBO_PATTERN = /^[A-Z0-9][A-Z0-9./-]*$/;

export class Tombo {
  private constructor(private readonly normalizedValue: string) {}

  static create(value: string): Tombo {
    return new Tombo(normalizeTombo(value));
  }

  get value(): string {
    return this.normalizedValue;
  }

  equals(other: Tombo): boolean {
    return this.normalizedValue === other.normalizedValue;
  }

  toString(): string {
    return this.normalizedValue;
  }
}

export function normalizeTombo(value: string): string {
  const normalizedValue = value.trim().toUpperCase();

  if (normalizedValue.length === 0) {
    throw new Error("Tombo must not be blank.");
  }

  if (normalizedValue.length > MAX_TOMBO_LENGTH) {
    throw new Error(`Tombo must have at most ${MAX_TOMBO_LENGTH} characters.`);
  }

  if (!TOMBO_PATTERN.test(normalizedValue)) {
    throw new Error("Tombo must contain only uppercase letters, numbers, dot, slash or hyphen.");
  }

  return normalizedValue;
}
