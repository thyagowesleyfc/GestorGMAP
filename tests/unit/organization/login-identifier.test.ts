import { describe, expect, it } from "vitest";

import { normalizeLoginIdentifier } from "../../../src/modules/organization/domain/login-identifier";

describe("login identifier", () => {
  it("normalizes login identifiers without choosing a semantic type", () => {
    expect(normalizeLoginIdentifier("  Usuario.GMAP  ")).toBe("usuario.gmap");
  });

  it("keeps normalized identifiers stable", () => {
    expect(normalizeLoginIdentifier("usuario.gmap")).toBe("usuario.gmap");
  });

  it("rejects blank login identifiers", () => {
    expect(() => normalizeLoginIdentifier("  ")).toThrow("Login identifier must not be blank.");
  });
});
