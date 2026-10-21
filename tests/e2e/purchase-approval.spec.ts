import { test, expect, type Page } from "@playwright/test";
import type { PurchaseDetail } from "../../src/lib/purchase-display";
import { businessActor as actor } from "./business-actor";
const headers = { Origin: "http://127.0.0.1:3101" };
async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function create(page: Page, title: string, submit = true) {
  const saved = await page.request.post("/api/purchase-drafts", {
    headers,
    data: {
      title,
      reason: "采购审批页面验收",
      expectedDate: "2028-11-01",
      budgetLimit: "500.00",
      selectionReason: "较高报价含保修与安装",
      items: [
        {
          name: "设备",
          specification: "A1",
          quantity: "2",
          unit: "台",
          unitPrice: "100.01",
        },
      ],
      quotes: [
        {
          supplierName: "厂家甲",
          quoteDate: "2028-01-01",
          amount: "200",
          basis: "原厂报价",
          selected: false,
        },
        {
          supplierName: "厂家乙",
          quoteDate: "2028-01-01",
          amount: "210",
          basis: "含延长保修",
          selected: true,
        },
      ],
    },
  });
  expect(saved.status()).toBe(201);
  const draft = (await saved.json()).data;
  if (submit) {
    const sent = await page.request.post(
      `/api/purchase-drafts/${draft.id}/submit`,
      { headers, data: { version: draft.version } },
    );
    expect(sent.status()).toBe(200);
  }
  return draft.id as string;
}
async function detail(page: Page, id: string): Promise<PurchaseDetail> {
  const response = await page.request.get(`/api/purchase-applications/${id}`);
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
    path: `tmp/screenshots/purchase-approval-${name}.png`,
    fullPage: true,
  });
}

test("本人申请、两级审批确认、待办切换、已办和终态刷新", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "roster_14");
  const id = await create(page, "两级页面验收");
  await page.getByRole("link", { name: "我的申请", exact: true }).click();
  await page.getByRole("link", { name: "采购申请", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "两级页面验收" }),
  ).toContainText("测试成员 20");
  await expect(page.getByRole("row").nth(1)).toContainText("200.02");
  await expect(page.getByRole("row").nth(1)).toContainText("500.00");
  await shot(page, "applications-desktop");
  await page.getByRole("link", { name: "查看详情", exact: true }).click();
  await expect(button(page, "通过审批")).toHaveCount(0);
  await expect(button(page, "撤回申请")).toBeVisible();
  const head = await actor(browser, "roster_20");
  const company = await actor(browser, "roster_19");
  try {
    await company.page.goto(`/purchase/applications/${id}`);
    await expect(company.page.locator(".notice-error")).toBeVisible();
    await expect(button(company.page, "通过审批")).toHaveCount(0);
    await head.page.goto("/purchase/tasks");
    await query(head.page, "两级页面验收");
    await expect(head.page.getByRole("row")).toHaveCount(2);
    await shot(head.page, "pending-desktop");
    await head.page.getByRole("link", { name: "查看并审批" }).click();
    await head.page.getByLabel("审批意见（驳回必填）").fill("同意采购");
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
    await head.page.goto("/purchase/tasks/handled");
    await query(head.page, "两级页面验收");
    await expect(head.page.getByRole("row").nth(1)).toContainText("审批中");
    await expect(head.page.getByRole("row").nth(1)).toContainText("已通过");
    await shot(head.page, "handled-desktop");
    await company.page.goto("/purchase/tasks");
    await query(company.page, "两级页面验收");
    await company.page.getByRole("link", { name: "查看并审批" }).click();
    await button(company.page, "通过审批").click();
    await button(company.page, "确认通过").click();
    await expect(
      company.page.getByText("通过操作已完成。", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(button(page, "撤回申请")).toHaveCount(0);
    await expect(page.locator(".purchase-section").first()).toContainText(
      "已通过",
    );
    expect((await detail(page, id)).logs).toHaveLength(3);
    await shot(page, "approved-desktop");
  } finally {
    await head.close();
    await company.close();
  }
  expect(errors).toEqual([]);
});

test("驳回必填、取消保留意见、手机列表和审批对话框", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_15");
  const id = await create(page, "移动驳回验收");
  const head = await actor(browser, "roster_20");
  try {
    await head.page.setViewportSize({ width: 390, height: 844 });
    await head.page.goto("/purchase/tasks");
    await query(head.page, "移动驳回验收");
    await expect(head.page.getByRole("row")).toHaveCount(2);
    await shot(head.page, "pending-mobile");
    await head.page.getByRole("link", { name: "查看并审批" }).click();
    await button(head.page, "驳回申请").click();
    await expect(head.page.getByLabel("审批意见（驳回必填）")).toBeFocused();
    await expect(
      head.page.getByText("驳回必须填写理由", { exact: true }),
    ).toBeVisible();
    await head.page.getByLabel("审批意见（驳回必填）").fill("请补充采购说明");
    await button(head.page, "驳回申请").click();
    await shot(head.page, "reject-mobile");
    await head.page.keyboard.press("Escape");
    await expect(head.page.getByLabel("审批意见（驳回必填）")).toHaveValue(
      "请补充采购说明",
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
  await signIn(page, "roster_16");
  const id = await create(page, "撤回竞争验收");
  const head = await actor(browser, "roster_20");
  try {
    await page.goto(`/purchase/applications/${id}`);
    await page.getByLabel("撤回说明（选填）").fill("采购取消");
    await button(page, "撤回申请").click();
    await button(page, "取消").click();
    expect((await detail(page, id)).application.status).toBe("pending");
    await head.page.goto(`/purchase/applications/${id}`);
    await button(head.page, "通过审批").click();
    await button(head.page, "确认通过").click();
    await expect(
      head.page.getByText("通过操作已完成。", { exact: true }),
    ).toBeVisible();
    await button(page, "撤回申请").click();
    await button(page, "确认撤回").click();
    await expect(button(page, "撤回申请")).toBeDisabled();
    await expect(page.getByLabel("撤回说明（选填）")).toHaveValue("采购取消");
    await shot(page, "conflict-desktop");
    await button(page, "重新读取详情").click();
    await expect(page.getByLabel("撤回说明（选填）")).toHaveValue("采购取消");
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
  await signIn(page, "roster_17");
  const id = await create(page, "响应丢失审批");
  const head = await actor(browser, "roster_20");
  try {
    await head.page.goto(`/purchase/applications/${id}`);
    let writes = 0;
    await head.page.route(
      `**/api/purchase-applications/${id}/tasks/*/decision`,
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
    await expect(
      head.page.getByText(/状态或写入结果可能已变化，已暂停操作/),
    ).toBeVisible();
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
  await signIn(page, "roster_18");
  for (let i = 0; i < 12; i++) await create(page, `筛选采购 ${i}`, false);
  await create(page, "筛选待审批");
  await page.goto("/purchase/applications");
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
  await query(page, "不存在的采购");
  await expect(
    page.getByText("没有符合条件的记录", { exact: true }),
  ).toBeVisible();
  await page.route("**/api/purchase-applications?*", (route) => route.abort());
  await button(page, "刷新列表").click();
  await expect(page.locator(".notice-error")).toContainText("网络连接失败");
  await page.unroute("**/api/purchase-applications?*");
  await button(page, "重新加载").click();
  await expect(
    page.getByText("没有符合条件的记录", { exact: true }),
  ).toBeVisible();
  await page.goto("/purchase/applications?page=999");
  await expect(
    page.getByText("本页没有记录，请返回上一页或重置查询", { exact: true }),
  ).toBeVisible();
  for (const invalid of [
    "page=0",
    "status=all&status=pending",
    "unexpected=1",
    "type=travel",
  ]) {
    await page.goto(`/purchase/applications?${invalid}`);
    await expect(page.locator(".notice-error")).toContainText("查询参数无效");
  }
  await page.goto("/purchase/applications?page=0");
  await expect(page.locator(".notice-error")).toContainText("查询参数无效");
  await page.getByRole("link", { name: "重置查询" }).click();
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "applications-mobile");
  await page.getByLabel("申请类型", { exact: true }).selectOption("travel");
  await expect(page).toHaveURL(/\/travel\/applications$/);
  await expect(
    page.getByRole("heading", { name: "我的差旅申请", exact: true }),
  ).toBeVisible();
  await page.getByLabel("申请类型", { exact: true }).selectOption("purchase");
  await expect(page).toHaveURL(/\/purchase\/applications$/);
  await expect(page.getByRole("row")).toHaveCount(11);
});

test("列表认证、管理员无正文和审批特权、会话失效后的动作跳转", async ({
  page,
  browser,
}) => {
  await page.goto("/purchase/tasks/handled");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "roster_00");
  const id = await create(page, "权限页面验收");
  const admin = await actor(browser, "admin");
  try {
    await admin.page.goto("/purchase/tasks");
    await expect(
      admin.page.getByText("没有符合条件的记录", { exact: true }),
    ).toBeVisible();
    await admin.page.goto(`/purchase/applications/${id}`);
    await expect(admin.page.locator(".notice-error")).toBeVisible();
    await expect(button(admin.page, "通过审批")).toHaveCount(0);
  } finally {
    await admin.close();
  }
  await page.goto(`/purchase/applications/${id}`);
  await expect(button(page, "撤回申请")).toBeVisible();
  await page.request.post("/api/auth/logout", { headers });
  await button(page, "撤回申请").click();
  await button(page, "确认撤回").click();
  await expect(page).toHaveURL(/\/login\?expired=1/);
});

test("撤回响应丢失只读核对，取消任务不计已办，混合版本不开放操作", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_12");
  const id = await create(page, "采购撤回丢失");
  await page.goto(`/purchase/applications/${id}`);
  await expect(button(page, "撤回申请")).toBeVisible();
  await page.route(
    `**/api/purchase-applications/${id}/attachments`,
    async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.data.version++;
      await route.fulfill({ response, json: data });
    },
  );
  await button(page, "刷新详情").click();
  await expect(page.locator(".notice-error")).toContainText(
    "读取期间申请状态已变化",
  );
  await expect(button(page, "撤回申请")).toHaveCount(0);
  await page.unroute(`**/api/purchase-applications/${id}/attachments`);
  await button(page, "重新加载").click();
  let writes = 0;
  await page.route(
    `**/api/purchase-applications/${id}/withdraw`,
    async (route) => {
      writes++;
      await route.fetch();
      await route.abort();
    },
  );
  await page.getByLabel("撤回说明（选填）").fill("采购计划取消");
  await button(page, "撤回申请").click();
  await button(page, "确认撤回").click();
  await expect(button(page, "撤回申请")).toBeDisabled();
  await expect(page.getByLabel("撤回说明（选填）")).toHaveValue("采购计划取消");
  await button(page, "重新读取详情").click();
  await expect(page.getByText("已撤回", { exact: true })).toBeVisible();
  await expect(button(page, "撤回申请")).toHaveCount(0);
  expect(writes).toBe(1);
  expect((await detail(page, id)).logs).toHaveLength(2);
  const head = await actor(browser, "roster_20");
  const company = await actor(browser, "roster_19");
  try {
    for (const suffix of ["", "/handled"]) {
      await head.page.goto(`/purchase/tasks${suffix}`);
      await query(head.page, "采购撤回丢失");
      await expect(
        head.page.getByText("没有符合条件的记录", { exact: true }),
      ).toBeVisible();
    }
    await head.page.goto(`/purchase/applications/${id}`);
    await expect(head.page.getByText("已撤回", { exact: true })).toBeVisible();
    await expect(button(head.page, "通过审批")).toHaveCount(0);
    await company.page.goto(`/purchase/applications/${id}`);
    await expect(company.page.locator(".notice-error")).toBeVisible();
  } finally {
    await head.close();
    await company.close();
  }
});

test("同人两节点需分别确认，写入互斥且始终携带实际任务与最新版本", async ({
  page,
  browser,
}) => {
  await signIn(page, "roster_13");
  const admin = await actor(browser, "admin");
  const response = await admin.page.request.get(
    "/api/admin/users?pageSize=100",
  );
  expect(response.status()).toBe(200);
  const users: import("../../src/lib/identity").UserIdentity[] = (
    await response.json()
  ).data.items;
  const headUser = users.find((user) => user.username === "roster_20")!;
  const companyUser = users.find((user) => user.username === "roster_19")!;
  async function roles(user: typeof headUser, next: typeof headUser.roles) {
    const result = await admin.page.request.patch(
      `/api/admin/users/${user.id}/access`,
      {
        headers,
        data: {
          departmentId: user.departmentId,
          status: "active",
          roles: next,
          reason: "测试库同人两节点验收及恢复",
        },
      },
    );
    expect(result.status()).toBe(200);
  }
  let head: Awaited<ReturnType<typeof actor>> | undefined;
  let release: (() => void) | undefined;
  try {
    await roles(companyUser, ["employee"]);
    await roles(headUser, ["employee", "department_head", "company_head"]);
    const id = await create(page, "同人双节点采购");
    const initial = await detail(page, id);
    head = await actor(browser, "roster_20");
    const approval = head.page;
    await approval.goto(`/purchase/applications/${id}`);
    const bodies: {
      version: number;
      decision: string;
      opinion: string;
      taskId: string;
    }[] = [];
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await approval.route(
      `**/api/purchase-applications/${id}/tasks/*/decision`,
      async (route) => {
        bodies.push({
          ...route.request().postDataJSON(),
          taskId: route.request().url().split("/").at(-2),
        });
        if (bodies.length === 1) await gate;
        await route.continue();
      },
    );
    await approval.getByLabel("审批意见（驳回必填）").fill("第一节点意见");
    await button(approval, "通过审批").click();
    await button(approval, "确认通过").click();
    await expect(button(approval, "处理中…")).toBeDisabled();
    await expect(button(approval, "刷新详情")).toBeDisabled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      version: 2,
      decision: "approve",
      opinion: "第一节点意见",
      taskId: initial.tasks[0].id,
    });
    release!();
    await expect(
      approval.getByRole("heading", {
        name: "当前审批：企业审批",
        exact: true,
      }),
    ).toBeVisible();
    await expect(approval.getByLabel("审批意见（驳回必填）")).toHaveValue("");
    expect(bodies).toHaveLength(1);
    expect((await detail(page, id)).application.status).toBe("pending");
    await button(approval, "通过审批").click();
    await expect(approval.getByRole("dialog")).toContainText(
      "第 2 个节点：企业审批",
    );
    await button(approval, "确认通过").click();
    await expect(button(approval, "通过审批")).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].taskId).toBe(initial.tasks[1].id);
    expect(bodies[1].version).toBe(3);
    expect((await detail(page, id)).application.status).toBe("approved");
    await approval.goto("/purchase/tasks/handled");
    await query(approval, "同人双节点采购");
    await expect(approval.getByRole("row")).toHaveCount(3);
    await expect(approval.getByRole("row").nth(1)).toContainText("已通过");
    await shot(approval, "same-person-handled");
  } finally {
    release?.();
    await head?.close();
    await roles(headUser, headUser.roles);
    await roles(companyUser, companyUser.roles);
    await admin.close();
  }
});
