import { expect, test } from "@playwright/test";

test("exibe a tela de login", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
  await expect(page.getByLabel("Identificador de login")).toBeVisible();
  await expect(page.getByLabel("Senha")).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
});

test("mostra erro publico quando o login falha", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 401,
      body: JSON.stringify({ error: "Credenciais inv\u00e1lidas." })
    });
  });

  await page.goto("/login");
  await page.getByLabel("Identificador de login").fill("usuario.gmap");
  await page.getByLabel("Senha").fill("SenhaErrada123");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByText("Credenciais inv\u00e1lidas.")).toBeVisible();
});

test("redireciona apos login bem-sucedido", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ ok: true, expires_at: "2026-09-14T20:00:00.000Z" })
    });
  });

  await page.goto("/login");
  await page.getByLabel("Identificador de login").fill("usuario.gmap");
  await page.getByLabel("Senha").fill("SenhaForte123");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL("/");
});
