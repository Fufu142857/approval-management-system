import { test, expect, type Page, type Browser } from "@playwright/test";
import type { NotificationItem } from "../../src/lib/notifications";
import type { TravelDetail } from "../../src/lib/travel-display";
const headers = { Origin: "http://127.0.0.1:3101" };
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await button(page, "登录").click();
  await expect(page).toHaveURL(/\/account$/);
}
async function actor(browser: Browser, username: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, username);
  return { page, close: () => context.close() };
}
async function create(page: Page, title: string) {
  const saved = await page.request.post("/api/travel-drafts", {
    headers,
    data: {
      title,
      departure: "杭州",
      destination: "上海",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      purpose: "通知页面验收",
      transportation: "高铁",
      budget: "100.00",
    },
  });
  expect(saved.status()).toBe(201);
  const draft = (await saved.json()).data;
  const sent = await page.request.post(
    `/api/travel-drafts/${draft.id}/submit`,
    { headers, data: { version: draft.version } },
  );
  expect(sent.status()).toBe(200);
  return draft.id as string;
}
async function detail(page: Page, id: string): Promise<TravelDetail> {
  const res = await page.request.get(`/api/travel-applications/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()).data;
}
async function withdraw(page: Page, id: string) {
  const data = await detail(page, id);
  const res = await page.request.post(
    `/api/travel-applications/${id}/withdraw`,
    { headers, data: { version: data.application.version } },
  );
  expect(res.status()).toBe(200);
}
async function decide(page: Page, id: string, decision: "approve" | "reject") {
  const data = await detail(page, id);
  const task = data.tasks.find((item) => item.status === "pending")!;
  const res = await page.request.post(
    `/api/travel-applications/${id}/tasks/${task.id}/decision`,
    {
      headers,
      data: {
        version: data.application.version,
        decision,
        opinion: "通知验收",
      },
    },
  );
  expect(res.status()).toBe(200);
}
async function notifications(page: Page): Promise<NotificationItem[]> {
  const response = await page.request.get("/api/notifications?pageSize=100");
  expect(response.status()).toBe(200);
  return (await response.json()).data.items;
}
async function shot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/notifications-${name}.png`,
    fullPage: true,
  });
}
async function visibility(page: Page, value: "hidden" | "visible") {
  // Exercise the real visibility event handler deterministically in headless Chrome.
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}

test("通知详情、显式已读、旧待办状态和受控申请跳转", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_12");
  const id = await create(page, "通知完整流转");
  const head = await actor(browser, "roster_20");
  const finance = await actor(browser, "roster_21");
  try {
    const event = (await notifications(head.page)).find(
      (item) => item.appId === id,
    )!;
    await head.page.goto(`/notifications/${event.id}`);
    await expect(
      head.page.getByRole("heading", { name: event.title }),
    ).toBeVisible();
    expect(
      (await notifications(head.page)).find((item) => item.id === event.id)!
        .readAt,
    ).toBeNull();
    await shot(head.page, "detail-desktop");
    await button(head.page, "标记已读").click();
    await expect(button(head.page, "标记已读")).toHaveCount(0);
    const firstRead = (await notifications(head.page)).find(
      (item) => item.id === event.id,
    )!.readAt;
    const repeat = await head.page.request.post(
      `/api/notifications/${event.id}/read`,
      { headers, data: {} },
    );
    expect(Date.parse((await repeat.json()).data.readAt)).toBe(
      Date.parse(firstRead!),
    );
    expect(
      (await notifications(head.page)).find((item) => item.id === event.id)!
        .readAt,
    ).toBe(firstRead);
    await head.page
      .getByRole("link", { name: "查看申请详情", exact: true })
      .click();
    await expect(button(head.page, "通过审批")).toBeVisible();
    await decide(head.page, id, "approve");
    await decide(finance.page, id, "approve");
    await head.page.goto(`/notifications/${event.id}`);
    await expect(
      head.page.getByText("原任务当前状态：已通过", { exact: true }),
    ).toBeVisible();
    await head.page
      .getByRole("link", { name: "查看申请详情", exact: true })
      .click();
    await expect(button(head.page, "通过审批")).toHaveCount(0);
    await page.goto("/notifications");
    await expect(page.locator(".notification-item")).toContainText("申请通过");
    await page.getByRole("link", { name: "查看通知", exact: true }).click();
    await expect(
      page.getByText("申请当前状态：已通过", { exact: true }),
    ).toBeVisible();
  } finally {
    await head.close();
    await finance.close();
  }
});

test("未读筛选、分页与 URL 恢复、末页清空和手机外观", async ({ page }) => {
  await signIn(page, "roster_13");
  for (let i = 0; i < 11; i++)
    await withdraw(page, await create(page, `通知分页 ${i}`));
  await page.getByRole("link", { name: /^通知中心/ }).click();
  await expect(page.locator(".notification-item")).toHaveCount(10);
  await expect(
    page.getByText("本人全部未读：11", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("未读通知 11", { exact: true })).toBeVisible();
  await shot(page, "list-desktop");
  await button(page, "未读通知").click();
  await expect(page).toHaveURL(/state=unread/);
  await button(page, "下一页").click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.locator(".notification-item")).toHaveCount(1);
  await button(page, "标记已读").click();
  await expect(
    page.getByText("没有符合条件的通知", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("未读通知 10", { exact: true })).toBeVisible();
  await button(page, "返回第一页").click();
  await expect(page.locator(".notification-item")).toHaveCount(10);
  await button(page, "已读通知").click();
  await expect(page.locator(".notification-item")).toHaveCount(1);
  await expect(
    page.getByText("本人全部未读：10", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "list-mobile");
  await page.getByRole("link", { name: "查看通知", exact: true }).click();
  await expect(
    page.getByText("申请当前状态：已撤回", { exact: true }),
  ).toBeVisible();
  await shot(page, "detail-mobile");
  await page.goto("/notifications?state=unread&state=read");
  await expect(page.locator(".notice-error")).toContainText("查询参数无效");
  await page.getByRole("link", { name: "重置查询" }).click();
  await expect(page.locator(".notification-item")).toHaveCount(10);
});

test("前台自动更新真实结果、后台暂停、恢复和离页停止列表轮询", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_14");
  const id = await create(page, "自动通知驳回");
  const head = await actor(browser, "roster_20");
  try {
    await page.clock.install();
    let listReads = 0;
    let countReads = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/notifications?")) listReads++;
      if (req.url().endsWith("/api/notifications/unread-count")) countReads++;
    });
    await page.goto("/notifications");
    await expect(
      page.getByText("没有符合条件的通知", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("未读通知 0", { exact: true })).toBeVisible();
    await decide(head.page, id, "reject");
    await page.clock.fastForward(31000);
    await expect(page.locator(".notification-item")).toContainText("申请驳回");
    await expect(page.getByLabel("未读通知 1", { exact: true })).toBeVisible();
    await visibility(page, "hidden");
    const before = { listReads, countReads };
    const next = await create(page, "隐藏期间撤回");
    await withdraw(page, next);
    await page.clock.fastForward(65000);
    expect({ listReads, countReads }).toEqual(before);
    await visibility(page, "visible");
    await expect(page.locator(".notification-item")).toHaveCount(2);
    await expect(page.getByLabel("未读通知 2", { exact: true })).toBeVisible();
    await shot(page, "poll-results-desktop");
    await page.getByRole("link", { name: "审批管理系统", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    const offPage = listReads;
    const oldCount = countReads;
    await page.clock.fastForward(31000);
    await expect.poll(() => countReads).toBeGreaterThan(oldCount);
    expect(listReads).toBe(offPage);
    await page.getByLabel("用户菜单").click();
    await button(page, "退出登录").click();
    await expect(page).toHaveURL(/\/login$/);
    const loggedOut = { listReads, countReads };
    await page.clock.fastForward(65000);
    expect({ listReads, countReads }).toEqual(loggedOut);
  } finally {
    await head.close();
  }
});

test("网络失败保留旧列表、重试和已读响应丢失后回查不重放", async ({ page }) => {
  await signIn(page, "roster_15");
  await withdraw(page, await create(page, "通知失败恢复"));
  await page.goto("/notifications");
  await expect(page.locator(".notification-item")).toHaveCount(1);
  await page.route("**/api/notifications?*", (route) => route.abort());
  await button(page, "刷新通知").click();
  await expect(page.locator(".notice-error")).toContainText(
    "上次成功获取的数据",
  );
  await expect(page.locator(".notification-item")).toHaveCount(1);
  await expect(button(page, "标记已读")).toBeDisabled();
  await shot(page, "stale-desktop");
  await page.unroute("**/api/notifications?*");
  await button(page, "重新加载").click();
  await expect(page.locator(".notice-error")).toHaveCount(0);
  let writes = 0;
  await page.route("**/api/notifications/*/read", async (route) => {
    writes++;
    await route.fetch();
    await route.abort();
  });
  await button(page, "标记已读").click();
  await expect(page.locator(".notice-error")).toContainText(
    "已重新查询阅读状态",
  );
  await expect(button(page, "标记已读")).toHaveCount(0);
  await expect(page.getByLabel("未读通知 0", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  expect((await notifications(page))[0].readAt).not.toBeNull();
});

test("匿名与跨人通知隔离、空目标不跳转、会话失效停止轮询", async ({
  page,
  browser,
}) => {
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "roster_16");
  await withdraw(page, await create(page, "通知授权边界"));
  const item = (await notifications(page))[0];
  const admin = await actor(browser, "admin");
  try {
    await admin.page.goto(`/notifications/${item.id}`);
    await expect(admin.page.locator(".notice-error")).toContainText(
      "通知不存在或无权访问",
    );
    await expect(
      admin.page.getByRole("link", { name: "查看申请详情" }),
    ).toHaveCount(0);
    await admin.page.goto("/notifications");
    await expect(
      admin.page.getByText("没有符合条件的通知", { exact: true }),
    ).toBeVisible();
  } finally {
    await admin.close();
  }
  await page.route(`**/api/notifications/${item.id}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.target = null;
    json.data.task = null;
    await route.fulfill({ response, json });
  });
  await page.goto(`/notifications/${item.id}`);
  await expect(
    page.getByText("关联申请当前不可访问", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "查看申请详情" })).toHaveCount(0);
  await button(page, "标记已读").click();
  await expect(button(page, "标记已读")).toHaveCount(0);
  await page.unroute(`**/api/notifications/${item.id}`);
  await page.clock.install();
  await page.goto("/notifications");
  await expect(page.locator(".notification-item")).toHaveCount(1);
  await page.request.post("/api/auth/logout", { headers });
  await page.clock.fastForward(31000);
  await expect(page).toHaveURL(/\/login\?expired=1/);
});

test("慢请求不重叠、旧查询取消不覆盖新筛选、退出中停止通知请求", async ({
  page,
}) => {
  await signIn(page, "roster_17");
  await withdraw(page, await create(page, "慢通知请求"));
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  await page.route("**/api/notifications?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("state") !== "all")
      return route.continue();
    started++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.goto("/notifications");
  await expect.poll(() => started).toBe(1);
  await page.clock.fastForward(31000);
  expect(started).toBe(1);
  await button(page, "已读通知").click();
  await expect(
    page.getByText("没有符合条件的通知", { exact: true }),
  ).toBeVisible();
  release();
  await expect(page.locator(".notification-item")).toHaveCount(0);
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  await page.route("**/api/auth/logout", async (route) => {
    await logoutGate;
    await route.continue();
  });
  let reads = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/notifications")) reads++;
  });
  await page.getByLabel("用户菜单").click();
  await button(page, "退出登录").click();
  await expect(button(page, "退出中…")).toBeDisabled();
  const before = reads;
  await page.clock.fastForward(10000);
  await visibility(page, "hidden");
  await visibility(page, "visible");
  expect(reads).toBe(before);
  releaseLogout();
  await expect(page).toHaveURL(/\/login$/);
});
