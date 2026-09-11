import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const expectedModules = [
  "organization",
  "catalog",
  "entities",
  "requests",
  "contracts",
  "receiving",
  "stock",
  "logistics",
  "patrimony",
  "maintenance",
  "inspection",
  "reporting",
  "integrations"
];

describe("modular structure", () => {
  it("keeps the official bounded context folders available", () => {
    const root = join(process.cwd(), "src", "modules");

    for (const moduleName of expectedModules) {
      expect(existsSync(join(root, moduleName, "README.md")), moduleName).toBe(true);
    }
  });

  it("keeps the worker folder available for future background processes", () => {
    expect(existsSync(join(process.cwd(), "src", "worker", "README.md"))).toBe(true);
  });
});
