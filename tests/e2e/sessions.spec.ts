import { expect, test } from "@playwright/test";

const activeSessions = [
  {
    id: "session-1",
    current: true,
    user_agent: "Chrome no Windows",
    ip_address: "203.0.113.10",
    expires_at: "2026-09-14T20:00:00.000Z",
    last_seen_at: "2026-09-14T12:00:00.000Z",
    created_at: "2026-09-14T11:00:00.000Z"
  },
  {
    id: "session-2",
    current: false,
    user_agent: null,
    ip_address: null,
    expires_at: "2026-09-14T20:00:00.000Z",
    last_seen_at: "2026-09-14T11:30:00.000Z",
    created_at: "2026-09-14T10:00:00.000Z"
  }
];

test("lista sessoes ativas", async ({ page }) => {
  await page.route("**/api/auth/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ sessions: activeSessions })
    });
  });

  await page.goto("/sessoes");

  await expect(page.getByRole("heading", { name: "Minhas sess\u00f5es" })).toBeVisible();
  await expect(page.getByText("Chrome no Windows")).toBeVisible();
  await expect(page.getByText("Sess\u00e3o atual")).toBeVisible();
  await expect(page.getByText("Dispositivo n\u00e3o identificado")).toBeVisible();
});

test("bloqueia uma segunda aba operacional e permite assumir", async ({ context }) => {
  await context.route("**/api/auth/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ sessions: activeSessions })
      });
      return;
    }

    await route.continue();
  });

  const firstPage = await context.newPage();
  const secondPage = await context.newPage();

  await firstPage.goto("/sessoes");
  await expect(firstPage.getByRole("heading", { name: "Minhas sess\u00f5es" })).toBeVisible();
  await expect(firstPage.getByRole("alertdialog")).toBeHidden();
  await firstPage.waitForFunction(
    () => window.localStorage.getItem("gestor-gmap:active-operational-tab") !== null
  );

  await secondPage.goto("/sessoes");
  await expect(secondPage.getByRole("alertdialog")).toContainText(
    "Outra aba operacional est\u00e1 ativa"
  );

  await secondPage.getByRole("button", { name: "Assumir esta aba" }).click();

  await expect(secondPage.getByRole("alertdialog")).toBeHidden();
  await expect(firstPage.getByRole("alertdialog")).toContainText(
    "Outra aba operacional est\u00e1 ativa"
  );

  await firstPage.close();
  await secondPage.close();
});

test("nao bloqueia a tela de login quando ha outra aba operacional", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "gestor-gmap:active-operational-tab",
      JSON.stringify({
        tabId: "outra-aba",
        path: "/sessoes",
        lastSeenAt: Date.now()
      })
    );
  });

  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toBeHidden();
});

test("revoga uma sessao que nao e a atual", async ({ page }) => {
  let deleteCalled = false;

  await page.route("**/api/auth/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ sessions: activeSessions })
      });
      return;
    }

    await route.continue();
  });
  await page.route("**/api/auth/sessions/session-2", async (route) => {
    deleteCalled = route.request().method() === "DELETE";
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto("/sessoes");
  await page
    .locator("li")
    .filter({ hasText: "Dispositivo n\u00e3o identificado" })
    .getByRole("button", { name: "Encerrar" })
    .click();

  await expect(page.getByText("Dispositivo n\u00e3o identificado")).toBeHidden();
  expect(deleteCalled).toBe(true);
});

test("orienta login quando a sessao expira", async ({ page }) => {
  await page.route("**/api/auth/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 401,
      body: JSON.stringify({ error: "Sessao nao autenticada." })
    });
  });

  await page.goto("/sessoes");

  await expect(
    page.getByText("Sua sess\u00e3o expirou. Entre novamente para continuar.")
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Entrar novamente" })).toHaveAttribute(
    "href",
    "/login"
  );
});

test("mostra estado vazio quando nao ha sessoes ativas", async ({ page }) => {
  await page.route("**/api/auth/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ sessions: [] })
    });
  });

  await page.goto("/sessoes");

  await expect(page.getByText("Nenhuma sess\u00e3o ativa encontrada.")).toBeVisible();
});

test("orienta login ao encerrar a sessao atual", async ({ page }) => {
  await page.route("**/api/auth/sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({ sessions: activeSessions })
      });
      return;
    }

    await route.continue();
  });
  await page.route("**/api/auth/sessions/session-1", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto("/sessoes");
  await page
    .locator("li")
    .filter({ hasText: "Chrome no Windows" })
    .getByRole("button", { name: "Encerrar" })
    .click();

  await expect(
    page.getByText("Sess\u00e3o atual encerrada. Entre novamente para continuar.")
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Entrar novamente" })).toHaveAttribute(
    "href",
    "/login"
  );
});
