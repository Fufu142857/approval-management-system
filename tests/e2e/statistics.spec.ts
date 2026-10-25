import { test, expect, type Page } from "@playwright/test";
import type { FixedBusinessStatistics } from "../../src/lib/statistics";
import type { ReimbursementDetail } from "../../src/lib/reimbursement-display";
import { businessActor } from "./business-actor";
const headers = { Origin: "http://127.0.0.1:3101" };
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function stats(
  page: Page,
  search = "",
): Promise<FixedBusinessStatistics> {
  const response = await page.request.get(`/api/statistics${search}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function check(page: Page, expected: FixedBusinessStatistics) {
  await expect(page.getByTestId("statistics-total")).toHaveText(
    String(expected.applications.total),
  );
  await expect(page.getByTestId("statistics-tasks")).toHaveText(
    String(expected.pendingTasks.total),
  );
  for (const [status, count] of Object.entries(expected.applications.statuses))
    await expect(page.getByTestId(`statistics-${status}`)).toContainText(
      `${count} 单`,
    );
}
async function create(page: Page, submit = true) {
  const response = await page.request.post("/api/reimbursement-drafts", {
    headers,
    data: {
      title: "统计页面真实报销",
      description: "统计验证",
      independentReason: "临时独立支出",
      items: [
        {
          category: "transport",
          expenseDate: "2028-02-29",
          purpose: "交通",
          amount: "0.30",
          noReceipt: true,
          noReceiptReason: "票据遗失",
        },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const draft = (await response.json()).data;
  if (submit)
    expect(
      (
        await page.request.post(
          `/api/reimbursement-drafts/${draft.id}/submit`,
          { headers, data: { version: draft.version } },
        )
      ).status(),
    ).toBe(200);
  return draft.id as string;
}
async function decide(page: Page, id: string, decision = "approve") {
  const response = await page.request.get(
    `/api/reimbursement-applications/${id}`,
  );
  expect(response.status()).toBe(200);
  const detail: ReimbursementDetail = (await response.json()).data;
  const task = detail.tasks.find((task) => task.status === "pending")!;
  expect(
    (
      await page.request.post(
        `/api/reimbursement-applications/${id}/tasks/${task.id}/decision`,
        {
          headers,
          data: {
            version: detail.application.version,
            decision,
            opinion: "统计验收",
          },
        },
      )
    ).status(),
  ).toBe(200);
}
async function shot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/statistics-${name}.png`,
    fullPage: true,
  });
}

test("真实申请不含草稿，审批刷新、状态图与精确金额，部门范围和本人待办独立", async ({
  browser,
}) => {
  const owner = await businessActor(browser, "roster_06");
  const head = await businessActor(browser, "roster_20");
  const finance = await businessActor(browser, "roster_21");
  try {
    const before = await stats(owner.page);
    await create(owner.page, false);
    expect(await stats(owner.page)).toEqual(before);
    const id = await create(owner.page);
    const pending = await stats(owner.page);
    expect(pending.applications.total).toBe(before.applications.total + 1);
    await owner.page
      .getByRole("link", { name: "查询统计", exact: true })
      .click();
    await expect(
      owner.page.getByRole("link", { name: "查询统计", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await check(owner.page, pending);
    await head.page.goto("/statistics");
    const personal = await stats(head.page);
    await check(head.page, personal);
    await head.page
      .getByLabel("统计范围", { exact: true })
      .selectOption("department");
    await button(head.page, "查询").click();
    await expect(head.page).toHaveURL(/scope=department/);
    const department = await stats(head.page, "?scope=department");
    await check(head.page, department);
    expect(department.applications.total).toBeGreaterThan(
      personal.applications.total,
    );
    // Both actors share this department: scope changes application ownership, not actual task ownership.
    expect(department.pendingTasks).toEqual(personal.pendingTasks);
    await decide(head.page, id);
    await decide(finance.page, id);
    await button(owner.page, "刷新统计").click();
    const approved = await stats(owner.page);
    await check(owner.page, approved);
    expect(approved.applications.statuses.approved).toBe(
      before.applications.statuses.approved + 1,
    );
    const amount = approved.applications.byType.find(
      (group) => group.type === "reimbursement",
    )!.approvedAmount!;
    const old = before.applications.byType.find(
      (group) => group.type === "reimbursement",
    )!.approvedAmount!;
    expect(BigInt(amount.replace(".", "")) - BigInt(old.replace(".", ""))).toBe(
      30n,
    );
    await expect(
      owner.page
        .getByRole("article", { name: "报销统计" })
        .locator(".statistics-amount"),
    ).toHaveText(amount.replace(/\B(?=(\d{3})+\.)/g, ","));
    await shot(owner.page, "desktop");
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await shot(owner.page, "mobile");
  } finally {
    await owner.close();
    await head.close();
    await finance.close();
  }
});

test("类型、部门、提交日筛选及历史导航恢复，空结果与反向日期", async ({
  browser,
}) => {
  const actor = await businessActor(browser, "roster_07");
  const page = actor.page;
  try {
    await create(page);
    await page.goto("/statistics");
    await check(page, await stats(page));
    await page
      .getByLabel("申请类型", { exact: true })
      .selectOption("reimbursement");
    await page.getByLabel("提交开始日期").fill("2099-01-01");
    await page.getByLabel("提交结束日期").fill("2099-12-31");
    await button(page, "查询").click();
    await expect(page).toHaveURL(/from=2099-01-01/);
    await check(page, await stats(page, new URL(page.url()).search));
    await expect(page.getByText("当前筛选下暂无已提交申请。")).toBeVisible();
    await expect(page.getByRole("article", { name: "采购统计" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("article", { name: "报销统计" })).toContainText(
      "0.00",
    );
    await page.goBack();
    await check(page, await stats(page));
    await expect(page.getByLabel("申请类型", { exact: true })).toHaveValue(
      "all",
    );
    await page.goForward();
    await expect(page.getByLabel("提交开始日期")).toHaveValue("2099-01-01");
    await page.getByLabel("提交结束日期").fill("2098-12-31");
    await button(page, "查询").click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "结束日期不能早于开始日期",
    );
    await page.getByRole("link", { name: "重置筛选" }).click();
    await expect(page).toHaveURL(/\/statistics$/);
    await page.getByLabel("申请所属部门").selectOption({ index: 1 });
    await button(page, "查询").click();
    await expect(page).toHaveURL(/departmentId=/);
    await check(page, await stats(page, new URL(page.url()).search));
  } finally {
    await actor.close();
  }
});

test("未知、重复与非法 URL 参数拒绝，历史不可用部门保留且可重置", async ({
  browser,
}) => {
  const actor = await businessActor(browser, "roster_08");
  const page = actor.page;
  try {
    for (const search of [
      "?type=all&type=travel",
      "?scope=company",
      "?status=approved",
      "?from=2026-02-30",
      "?from=",
    ]) {
      await page.goto(`/statistics${search}`);
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "统计筛选参数无效",
      );
      await expect(page.getByTestId("statistics-total")).toHaveCount(0);
    }
    const id = "11111111-1111-4111-8111-111111111111";
    await page.goto(`/statistics?departmentId=${id}`);
    await expect(page.getByLabel("申请所属部门")).toHaveValue(id);
    await check(page, await stats(page, `?departmentId=${id}`));
    await expect(page.getByTestId("statistics-total")).toHaveText("0");
  } finally {
    await actor.close();
  }
});

test("普通员工、管理员和财务不获部门范围，负责人不能伪造他部门", async ({
  browser,
}) => {
  for (const username of ["roster_09", "admin", "roster_21", "roster_19"]) {
    const actor = await businessActor(browser, username);
    try {
      await actor.page.goto("/statistics");
      await check(actor.page, await stats(actor.page));
      await expect(
        actor.page.getByLabel("统计范围", { exact: true }).locator("option"),
      ).toHaveCount(1);
      await actor.page.goto("/statistics?scope=department");
      await expect(
        actor.page.getByRole("main").getByRole("alert"),
      ).toContainText("仅当前部门负责人");
      expect(
        (
          await actor.page.request.get("/api/statistics?scope=department")
        ).status(),
      ).toBe(403);
    } finally {
      await actor.close();
    }
  }
  const head = await businessActor(browser, "roster_20");
  try {
    await head.page.goto(
      "/statistics?scope=department&departmentId=11111111-1111-4111-8111-111111111111",
    );
    await expect(head.page.getByRole("main").getByRole("alert")).toContainText(
      "仅当前部门负责人",
    );
  } finally {
    await head.close();
  }
});

test("读取失败与统计撤权清除旧结果，刷新恢复，不误跳管理员提示", async ({
  browser,
}) => {
  const actor = await businessActor(browser, "roster_10");
  const page = actor.page;
  try {
    await page.goto("/statistics");
    await check(page, await stats(page));
    for (const [status, code] of [
      [500, "INTERNAL_ERROR"],
      [403, "STATISTICS_FORBIDDEN"],
    ] as const) {
      await page.route("**/api/statistics?*", (route) =>
        route.fulfill({
          status,
          json: { error: { code, message: "统计暂不可用" } },
        }),
      );
      await button(page, "刷新统计").click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "当前没有可展示的统计结果",
      );
      await expect(page.getByTestId("statistics-total")).toHaveCount(0);
      await expect(page).toHaveURL(/\/statistics$/);
      await page.unroute("**/api/statistics?*");
      await button(page, "刷新统计").click();
      await check(page, await stats(page));
    }
  } finally {
    await actor.close();
  }
});

test("旧查询延迟不覆盖新筛选，加载时隐藏旧统计", async ({ browser }) => {
  const actor = await businessActor(browser, "roster_11");
  const page = actor.page;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/statistics");
    await check(page, await stats(page));
    const stale = await stats(page);
    stale.applications.total = 987654;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route("**/api/statistics?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("type") === "all") {
        started();
        await gate;
        await route.fulfill({ json: { data: stale } }).catch(() => {});
      } else await route.continue();
    });
    await button(page, "刷新统计").click();
    await requestStarted;
    await expect(page.getByText("正在读取统计…")).toBeVisible();
    await expect(page.getByTestId("statistics-total")).toHaveCount(0);
    await page.getByLabel("申请类型", { exact: true }).selectOption("travel");
    await button(page, "查询").click();
    await expect(page).toHaveURL(/type=travel/);
    const expected = await stats(page, "?scope=personal&type=travel");
    await check(page, expected);
    release();
    await expect(page.getByTestId("statistics-total")).not.toHaveText("987654");
    await check(page, expected);
  } finally {
    release();
    await actor.close();
  }
});

test("大额和缺失金额展示保持精度，手机无溢出（响应边界夹具）", async ({
  browser,
}) => {
  const actor = await businessActor(browser, "roster_12");
  const page = actor.page;
  try {
    const fixture = await stats(page);
    const purchase = fixture.applications.byType.find(
      (g) => g.type === "purchase",
    )!;
    purchase.approvedAmount = "12345678901234567890.01";
    const travel = fixture.applications.byType.find(
      (g) => g.type === "travel",
    )!;
    travel.approvedAmount = null;
    travel.approvedAmountMissingCount = 2;
    await page.route("**/api/statistics?*", (route) =>
      route.fulfill({ json: { data: fixture } }),
    );
    await page.goto("/statistics");
    await expect(page.getByRole("article", { name: "采购统计" })).toContainText(
      "12,345,678,901,234,567,890.01",
    );
    await expect(page.getByRole("article", { name: "差旅统计" })).toContainText(
      "无法完整合计",
    );
    await expect(page.getByRole("article", { name: "差旅统计" })).toContainText(
      "2 单已批准申请缺少金额",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "edge-mobile");
  } finally {
    await actor.close();
  }
});

test("统计会话失效返回登录，匿名页面不能读取", async ({ page, browser }) => {
  await page.goto("/statistics");
  await expect(page).toHaveURL(/\/login/);
  const actor = await businessActor(browser, "roster_13");
  try {
    await actor.page.goto("/statistics");
    await check(actor.page, await stats(actor.page));
    await actor.page.route("**/api/statistics?*", (route) =>
      route.fulfill({
        status: 401,
        json: { error: { code: "UNAUTHENTICATED", message: "登录已失效" } },
      }),
    );
    await button(actor.page, "刷新统计").click();
    await expect(actor.page).toHaveURL(/\/login\?expired=1/);
  } finally {
    await actor.close();
  }
});
