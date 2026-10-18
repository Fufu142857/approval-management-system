import { test, expect, type Page, type Browser } from "@playwright/test";
import type { TravelDetail } from "../../src/lib/travel-display";
const headers = { Origin: "http://127.0.0.1:3101" };
async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function actor(browser: Browser, username: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, username);
  return { page, close: () => context.close() };
}
async function create(page: Page, title: string, submit = true) {
  const saved = await page.request.post("/api/travel-drafts", {
    headers,
    data: {
      title,
      departure: "杭州",
      destination: "上海",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      purpose: "审批页面验收",
      transportation: "高铁",
      budget: "100.00",
    },
  });
  expect(saved.status()).toBe(201);
  const draft = (await saved.json()).data;
  if (submit) {
    const sent = await page.request.post(
      `/api/travel-drafts/${draft.id}/submit`,
      { headers, data: { version: draft.version } },
    );
    expect(sent.status()).toBe(200);
  }
  return draft.id as string;
}
async function detail(page: Page, id: string): Promise<TravelDetail> {
  const response = await page.request.get(`/api/travel-applications/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function query(page: Page, text: string) {
  await page.getByLabel("关键词", { exact: true }).fill(text);
  await button(page, "查询").click();
  await expect(page).toHaveURL(/keyword=/);
}
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function shot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/approval-${name}.png`,
    fullPage: true,
  });
}

test("本人申请、两级审批确认、待办切换、已办和终态刷新", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "roster_06");
  const id = await create(page, "两级页面验收");
  await page.getByRole("link", { name: "我的申请", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "两级页面验收" }),
  ).toContainText("测试成员 20");
  await shot(page, "applications-desktop");
  await page.getByRole("link", { name: "查看详情", exact: true }).click();
  await expect(button(page, "通过审批")).toHaveCount(0);
  await expect(button(page, "撤回申请")).toBeVisible();
  const head = await actor(browser, "roster_20");
  const finance = await actor(browser, "roster_21");
  try {
    await finance.page.goto(`/travel/applications/${id}`);
    await expect(finance.page.locator(".notice-error")).toBeVisible();
    await expect(button(finance.page, "通过审批")).toHaveCount(0);
    await head.page.goto("/travel/tasks");
    await query(head.page, "两级页面验收");
    await expect(head.page.getByRole("row")).toHaveCount(2);
    await shot(head.page, "pending-desktop");
    await head.page.getByRole("link", { name: "查看并审批" }).click();
    await head.page.getByLabel("审批意见（驳回必填）").fill("同意出行");
    await button(head.page, "通过审批").click();
    await expect(head.page.getByRole("dialog")).toContainText(
      "第 1 个节点：部门审批",
    );
    await shot(head.page, "confirm-desktop");
    await button(head.page, "取消").click();
    expect((await detail(page, id)).application.version).toBe(2);
    await button(head.page, "通过审批").click();
    await button(head.page, "确认通过").click();
    await expect(
      head.page.getByText("通过操作已完成。", { exact: true }),
    ).toBeVisible();
    await expect(button(head.page, "通过审批")).toHaveCount(0);
    await head.page.goto("/travel/tasks/handled");
    await query(head.page, "两级页面验收");
    await expect(head.page.getByRole("row").nth(1)).toContainText("审批中");
    await expect(head.page.getByRole("row").nth(1)).toContainText("已通过");
    await shot(head.page, "handled-desktop");
    await finance.page.goto("/travel/tasks");
    await query(finance.page, "两级页面验收");
    await finance.page.getByRole("link", { name: "查看并审批" }).click();
    await button(finance.page, "通过审批").click();
    await button(finance.page, "确认通过").click();
    await expect(
      finance.page.getByText("通过操作已完成。", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(button(page, "撤回申请")).toHaveCount(0);
    await expect(page.locator(".travel-section").first()).toContainText(
      "已通过",
    );
    expect((await detail(page, id)).logs).toHaveLength(3);
    await shot(page, "approved-desktop");
  } finally {
    await head.close();
    await finance.close();
  }
  expect(errors).toEqual([]);
});

test("驳回必填、取消保留意见、手机列表和审批对话框", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_07");
  const id = await create(page, "移动驳回验收");
  const head = await actor(browser, "roster_20");
  try {
    await head.page.setViewportSize({ width: 390, height: 844 });
    await head.page.goto("/travel/tasks");
    await query(head.page, "移动驳回验收");
    await expect(head.page.getByRole("row")).toHaveCount(2);
    await shot(head.page, "pending-mobile");
    await head.page.getByRole("link", { name: "查看并审批" }).click();
    await button(head.page, "驳回申请").click();
    await expect(head.page.getByLabel("审批意见（驳回必填）")).toBeFocused();
    await expect(
      head.page.getByText("驳回必须填写理由", { exact: true }),
    ).toBeVisible();
    await head.page.getByLabel("审批意见（驳回必填）").fill("请补充行程说明");
    await button(head.page, "驳回申请").click();
    await shot(head.page, "reject-mobile");
    await head.page.keyboard.press("Escape");
    await expect(head.page.getByLabel("审批意见（驳回必填）")).toHaveValue(
      "请补充行程说明",
    );
    await button(head.page, "驳回申请").click();
    await button(head.page, "确认驳回").click();
    await expect(
      head.page.getByText("驳回操作已完成。", { exact: true }),
    ).toBeVisible();
    await expect(button(head.page, "通过审批")).toHaveCount(0);
    await shot(head.page, "rejected-mobile");
    expect((await detail(page, id)).application.status).toBe("rejected");
  } finally {
    await head.close();
  }
});

test("撤回确认、与另一窗口审批冲突后刷新保留意见，终态不可重复操作", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_08");
  const id = await create(page, "撤回竞争验收");
  const head = await actor(browser, "roster_20");
  try {
    await page.goto(`/travel/applications/${id}`);
    await page.getByLabel("撤回说明（选填）").fill("行程取消");
    await button(page, "撤回申请").click();
    await button(page, "取消").click();
    expect((await detail(page, id)).application.status).toBe("pending");
    await head.page.goto(`/travel/applications/${id}`);
    await button(head.page, "通过审批").click();
    await button(head.page, "确认通过").click();
    await expect(
      head.page.getByText("通过操作已完成。", { exact: true }),
    ).toBeVisible();
    await button(page, "撤回申请").click();
    await button(page, "确认撤回").click();
    await expect(button(page, "撤回申请")).toBeDisabled();
    await expect(page.getByLabel("撤回说明（选填）")).toHaveValue("行程取消");
    await shot(page, "conflict-desktop");
    await button(page, "重新读取详情").click();
    await expect(page.getByLabel("撤回说明（选填）")).toHaveValue("行程取消");
    await button(page, "撤回申请").click();
    await button(page, "确认撤回").click();
    await expect(
      page.getByText("撤回操作已完成。", { exact: true }),
    ).toBeVisible();
    await expect(button(page, "撤回申请")).toHaveCount(0);
    const result = await detail(page, id);
    expect(result.application.status).toBe("withdrawn");
    expect(result.tasks[1].status).toBe("cancelled");
    expect(result.logs).toHaveLength(3);
  } finally {
    await head.close();
  }
});

test("审批写入响应丢失不重发，刷新核对真实结果", async ({ page, browser }) => {
  await signIn(page, "roster_09");
  const id = await create(page, "响应丢失审批");
  const head = await actor(browser, "roster_20");
  try {
    await head.page.goto(`/travel/applications/${id}`);
    let writes = 0;
    await head.page.route(
      `**/api/travel-applications/${id}/tasks/*/decision`,
      async (route) => {
        writes++;
        await route.fetch();
        await route.abort();
      },
    );
    await head.page.getByLabel("审批意见（驳回必填）").fill("只执行一次");
    await button(head.page, "通过审批").click();
    await button(head.page, "确认通过").click();
    await expect(button(head.page, "通过审批")).toBeDisabled();
    await expect(head.page.getByLabel("审批意见（驳回必填）")).toHaveValue(
      "只执行一次",
    );
    expect(writes).toBe(1);
    expect((await detail(page, id)).logs).toHaveLength(2);
    await button(head.page, "重新读取详情").click();
    await expect(button(head.page, "通过审批")).toHaveCount(0);
    await expect(
      head.page.getByText("只执行一次", { exact: true }),
    ).toBeVisible();
    expect(writes).toBe(1);
  } finally {
    await head.close();
  }
});

test("全状态列表筛选、网址恢复、分页空态、失败重试和无效查询", async ({
  page,
}) => {
  await signIn(page, "roster_10");
  for (let i = 0; i < 12; i++) await create(page, `筛选行程 ${i}`, false);
  await create(page, "筛选待审批");
  await page.goto("/travel/applications");
  await expect(page.getByRole("row")).toHaveCount(11);
  await button(page, "下一页").click();
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByRole("row")).toHaveCount(4);
  await page.getByLabel("申请状态", { exact: true }).selectOption("pending");
  await button(page, "查询").click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page).toHaveURL(/page=1/);
  await page.getByLabel("创建时间起始日期").fill("2026-12-31");
  await page.getByLabel("创建时间结束日期").fill("2026-01-01");
  await button(page, "查询").click();
  await expect(page.locator(".notice-error")).toContainText(
    "结束日期不能早于开始日期",
  );
  await button(page, "重置").click();
  await query(page, "不存在的行程");
  await expect(
    page.getByText("没有符合条件的记录", { exact: true }),
  ).toBeVisible();
  await page.route("**/api/travel-applications?*", (route) => route.abort());
  await button(page, "刷新列表").click();
  await expect(page.locator(".notice-error")).toContainText("网络连接失败");
  await page.unroute("**/api/travel-applications?*");
  await button(page, "重新加载").click();
  await expect(
    page.getByText("没有符合条件的记录", { exact: true }),
  ).toBeVisible();
  await page.goto("/travel/applications?page=0");
  await expect(page.locator(".notice-error")).toContainText("查询参数无效");
  await page.getByRole("link", { name: "重置查询" }).click();
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "applications-mobile");
});

test("列表认证、管理员无正文和审批特权、会话失效后的动作跳转", async ({
  page,
  browser,
}) => {
  await page.goto("/travel/tasks/handled");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "roster_11");
  const id = await create(page, "权限页面验收");
  const admin = await actor(browser, "admin");
  try {
    await admin.page.goto("/travel/tasks");
    await expect(
      admin.page.getByText("没有符合条件的记录", { exact: true }),
    ).toBeVisible();
    await admin.page.goto(`/travel/applications/${id}`);
    await expect(admin.page.locator(".notice-error")).toBeVisible();
    await expect(button(admin.page, "通过审批")).toHaveCount(0);
  } finally {
    await admin.close();
  }
  await page.goto(`/travel/applications/${id}`);
  await expect(button(page, "撤回申请")).toBeVisible();
  await page.request.post("/api/auth/logout", { headers });
  await button(page, "撤回申请").click();
  await button(page, "确认撤回").click();
  await expect(page).toHaveURL(/\/login\?expired=1/);
});
