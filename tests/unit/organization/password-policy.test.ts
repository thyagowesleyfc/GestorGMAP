import { describe, expect, it } from "vitest";

import {
  assertPasswordPolicy,
  evaluatePasswordPolicy
} from "../../../src/modules/organization/domain/password-policy";

describe("password policy", () => {
  it("accepts a password with minimum length, letters and numbers", () => {
    expect(evaluatePasswordPolicy("SenhaForte123")).toEqual({
      valid: true,
      violations: []
    });
  });

  it("reports all policy violations", () => {
    expect(evaluatePasswordPolicy("curta")).toEqual({
      valid: false,
      violations: ["TOO_SHORT", "MISSING_NUMBER"]
    });
  });

  it("throws when asserting an invalid password", () => {
    expect(() => assertPasswordPolicy("123456789012")).toThrow(
      "Password does not satisfy policy: MISSING_LETTER"
    );
  });
});
