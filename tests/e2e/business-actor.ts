import { expect, type Browser, type BrowserContext } from "@playwright/test";

// Business scenarios use fresh browser contexts but reuse authenticated sessions.
// Keep cookies in worker memory only; access changes may invalidate them server-side.
const sessions = new Map<
  string,
  Awaited<ReturnType<BrowserContext["storageState"]>>
>();
export async function businessActor(browser: Browser, username: string) {
  const context = await browser.newContext({
    storageState: sessions.get(username),
  });
  const page = await context.newPage();
  try {
    const current = sessions.has(username)
      ? await page.request.get("http://127.0.0.1:3101/api/auth/me")
      : null;
    if (!current?.ok()) {
      await page.goto("/login");
      await page.getByLabel("用户名", { exact: true }).fill(username);
      await page
        .getByLabel("密码", { exact: true })
        .fill("Browser-test-password");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page).toHaveURL(/\/account$/);
      sessions.set(username, await context.storageState());
    } else {
      await page.goto("/account");
      await expect(page).toHaveURL(/\/account$/);
    }
    return { page, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}
