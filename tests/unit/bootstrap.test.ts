import { describe, expect, it } from "vitest";

describe("bootstrap", () => {
  it("keeps the test runner available", () => {
    expect("GESTOR GMAP").toContain("GMAP");
  });
});
