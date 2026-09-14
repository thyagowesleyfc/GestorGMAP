import { expect, test } from "@playwright/test";

test("exibe a home inicial do GESTOR GMAP", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "GESTOR GMAP" })).toBeVisible();
  await expect(page.getByText("Ger\u00eancia de Materiais e Patrim\u00f4nio")).toBeVisible();
  await expect(page.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/login");
});
