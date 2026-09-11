import { expect, test } from "@playwright/test";

test("exibe a home inicial do GESTOR GMAP", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "GESTOR GMAP" })).toBeVisible();
  await expect(page.getByText("Gerência de Materiais e Patrimônio")).toBeVisible();
});
