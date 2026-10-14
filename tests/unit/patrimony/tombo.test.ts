import { describe, expect, it } from "vitest";

import { normalizeTombo, Tombo } from "../../../src/modules/patrimony/domain/tombo";

describe("tombo", () => {
  it("normalizes tombo values for stable comparison", () => {
    const tombo = Tombo.create("  pi-000123/2026  ");

    expect(tombo.value).toBe("PI-000123/2026");
    expect(tombo.toString()).toBe("PI-000123/2026");
  });

  it("compares tombos by normalized value", () => {
    expect(Tombo.create("pi-000123/2026").equals(Tombo.create("PI-000123/2026"))).toBe(true);
    expect(Tombo.create("PI-000123/2026").equals(Tombo.create("PI-000124/2026"))).toBe(false);
  });

  it("keeps numeric tombos valid", () => {
    expect(normalizeTombo("000123")).toBe("000123");
  });

  it("rejects blank tombo values", () => {
    expect(() => Tombo.create("  ")).toThrow("Tombo must not be blank.");
  });

  it("rejects values with unsupported characters or internal spaces", () => {
    for (const value of ["PI 000123", "PI_000123", "PATRIMÔNIO-1", "/000123"]) {
      expect(() => Tombo.create(value)).toThrow(/Tombo must contain/);
    }
  });

  it("rejects values longer than the persistence boundary", () => {
    expect(() => Tombo.create("A".repeat(65))).toThrow(/at most 64/);
  });
});
