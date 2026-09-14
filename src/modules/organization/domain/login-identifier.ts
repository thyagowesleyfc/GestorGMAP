export function normalizeLoginIdentifier(identifier: string): string {
  const normalizedIdentifier = identifier.trim().toLowerCase();

  if (normalizedIdentifier.length === 0) {
    throw new Error("Login identifier must not be blank.");
  }

  return normalizedIdentifier;
}
