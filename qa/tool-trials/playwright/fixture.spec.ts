import { test, expect } from "@playwright/test";

test("local page fetches and displays the API response", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "T24 tool trial" })).toBeVisible();
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/health"));
  await page.getByRole("button", { name: "Check API" }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText(process.env.TRIAL_NEGATIVE === "1" ? "broken" : "ok");
});

test("two browser contexts keep client state isolated", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    await pageA.goto("http://127.0.0.1:3100/");
    await pageB.goto("http://127.0.0.1:3100/");
    await pageA.evaluate(() => localStorage.setItem("trial-user", "A"));
    expect(await pageB.evaluate(() => localStorage.getItem("trial-user"))).toBeNull();
  } finally {
    await a.close();
    await b.close();
  }
});
