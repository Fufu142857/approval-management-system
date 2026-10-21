import { test, expect, type Page, type Browser } from "@playwright/test";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { PurchaseDraft } from "../../src/lib/purchase";
import type { PurchaseDetail } from "../../src/lib/purchase-display";
import type { NotificationItem } from "../../src/lib/notifications";
const headers = { Origin: "http://127.0.0.1:3101" };
const data = {
  title: "采购提交验收",
  reason: "实验室设备更换",
  expectedDate: "2028-03-01",
  budgetLimit: "500.00",
  project: "实验项目",
  selectionReason: "选择较高报价，因包含安装和延长保修",
  remarks: "送至实验室",
  items: [
    {
      name: "实验设备",
      specification: "A-1",
      quantity: "2",
      unit: "台",
      unitPrice: "100.01",
    },
  ],
  quotes: [
    {
      supplierName: "报价甲",
      quoteDate: "2028-02-01",
      amount: "200",
      basis: "原厂报价单",
    },
    {
      supplierName: "报价乙",
      quoteDate: "2028-02-02",
      amount: "210",
      basis: "含安装保修",
      selected: true,
    },
  ],
};
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function login(page: Page, username = "roster_01") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await button(page, "登录").click();
  await expect(page).toHaveURL(/\/account$/);
}
async function actor(browser: Browser, username: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, username);
  return { page, close: () => context.close() };
}
async function create(page: Page, title: string): Promise<PurchaseDraft> {
  const res = await page.request.post("/api/purchase-drafts", {
    headers,
    data: { ...data, title },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).data;
}
async function detail(page: Page, id: string): Promise<PurchaseDetail> {
  const res = await page.request.get(`/api/purchase-applications/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()).data;
}
async function openDraft(page: Page, draft: PurchaseDraft) {
  await page.goto(`/purchase/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
}
async function submit(page: Page) {
  await button(page, "提交申请").click();
  await expect(
    page.getByRole("dialog", { name: "确认提交采购申请" }),
  ).toBeVisible();
  await button(page, "确认提交").click();
}
async function submitted(page: Page) {
  await expect(page).toHaveURL(/\/purchase\/applications\/[a-f0-9-]+$/);
  await expect(
    page.getByRole("heading", { name: "审批进度", exact: true }),
  ).toBeVisible();
  await expect(button(page, "保存草稿")).toHaveCount(0);
  await expect(button(page, "通过")).toHaveCount(0);
}
async function shot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/purchase-submission-${name}.png`,
    fullPage: true,
  });
}
async function png() {
  return sharp({
    create: { width: 320, height: 180, channels: 3, background: "#dddddd" },
  })
    .png()
    .toBuffer();
}
async function decide(page: Page, id: string, decision: "approve" | "reject") {
  const before = await detail(page, id);
  const task = before.tasks.find((task) => task.status === "pending")!;
  const res = await page.request.post(
    `/api/purchase-applications/${id}/tasks/${task.id}/decision`,
    {
      headers,
      data: {
        version: before.application.version,
        decision,
        opinion: "采购审阅意见",
      },
    },
  );
  expect(res.status()).toBe(200);
}

test("采购完整校验、确认取消、最新保存版本提交与冻结详情/附件", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const draft = await create(page, "正常采购");
  await openDraft(page, draft);
  await page.locator("#budgetLimit").fill("1");
  await button(page, "提交申请").click();
  await expect(page.locator("#budgetLimit")).toBeFocused();
  await expect(
    page.getByText("预计采购总额不得超过预算上限", { exact: true }).first(),
  ).toBeVisible();
  await page.locator("#budgetLimit").fill("500");
  await page.locator("#items-0-specification").fill("");
  await button(page, "提交申请").click();
  await expect(page.locator("#items-0-specification")).toBeFocused();
  await page.locator("#items-0-specification").fill("A-1");
  await page.locator("#quotes-1-supplierName").fill("报价甲");
  await button(page, "提交申请").click();
  await expect(page.getByText(/供应商不能重复/)).toBeVisible();
  await page.locator("#quotes-1-supplierName").fill("报价乙");
  const evidence = page.locator(".purchase-quote-evidence").first();
  await evidence.locator("summary").click();
  await page.getByLabel("线上报价 1", { exact: true }).check();
  await page
    .locator("#quotes-0-purchaseUrl")
    .fill("https://example.invalid/quote");
  await evidence.locator("summary").click();
  await button(page, "提交申请").click();
  await expect(
    page.getByText(/线上报价须上传该报价的 JPEG\/PNG 截图/),
  ).toBeVisible();
  // A PDF attached to the same quote is valid evidence but cannot replace an online screenshot.
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Purchase submitted evidence", { x: 40, y: 720 });
  await page.getByLabel("选择报价附件").setInputFiles({
    name: "证明.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(button(page, "预览 证明.pdf")).toBeVisible();
  await button(page, "提交申请").click();
  await expect(
    page.getByText(/线上报价须上传该报价的 JPEG\/PNG 截图/),
  ).toBeVisible();
  const bytes = await png();
  await page.getByLabel("选择报价附件").setInputFiles({
    name: "报价截图.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect(button(page, "预览 报价截图.png")).toBeVisible();
  await page.locator("#title").fill("确认时保存的新标题");
  await button(page, "提交申请").click();
  const dialog = page.getByRole("dialog", { name: "确认提交采购申请" });
  await expect(dialog).toContainText("200.02 元");
  await expect(dialog).toContainText("部门负责人 → 企业负责人");
  await shot(page, "confirm-desktop");
  await button(page, "取消").click();
  expect(
    (await (await page.request.get(`/api/purchase-drafts/${draft.id}`)).json())
      .data.title,
  ).toBe("正常采购");
  await submit(page);
  await submitted(page);
  const result = await detail(page, draft.id);
  expect(result.application.version).toBe(draft.version + 4); // two files, save, submit
  expect(result.application.title).toBe("确认时保存的新标题");
  expect(result.application.totalAmount).toBe("200.02");
  expect(result.workflow.routeSnapshot.selectedNotLowest).toBe(true);
  await expect(
    page.getByRole("definition").filter({ hasText: "未选最低报价" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看购买链接（新窗口）" }),
  ).toHaveAttribute("href", "https://example.invalid/quote");
  await expect(
    page.getByText("2. 企业审批 · 测试成员 19", { exact: true }),
  ).toBeVisible();
  await shot(page, "detail-desktop");
  await button(page, "预览 证明.pdf").click();
  await expect(
    page.getByRole("img", { name: "PDF 第 1 页", exact: true }),
  ).toHaveAttribute("data-rendered", "true");
  await shot(page, "pdf-desktop");
  await page.keyboard.press("Escape");
  const downloaded = page.waitForEvent("download");
  await button(page, "下载 报价截图.png").click();
  const download = await downloaded;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  await page.route("**/attachments/*/content", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "ATTACHMENT_UNAVAILABLE",
          message: "附件缺失或完整性校验失败",
        },
      },
    }),
  );
  await button(page, "预览 报价截图.png").click();
  await expect(page.locator(".notice-error")).toContainText("附件缺失");
  await page.unroute("**/attachments/*/content");
  await expect(button(page, "删除 报价截图.png")).toHaveCount(0);
  await page.reload();
  await submitted(page);
  await page.goto(`/purchase/drafts/${draft.id}`);
  await expect(page.locator(".notice-error")).toContainText("已不是草稿");
  await page.getByRole("link", { name: "查看已提交申请", exact: true }).click();
  await submitted(page);
  expect(errors).toEqual([]);
});

test("手机新建单一来源，先创建再提交，未知报价金额保持未知", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "roster_02");
  await page.goto("/purchase/new");
  await button(page, "提交申请").click();
  await expect(page.locator("#title")).toBeFocused();
  for (const [key, value] of Object.entries({
    title: "手机单一来源",
    reason: "原设备配件",
    expectedDate: "2028-02-01",
    budgetLimit: "100",
    selectionReason: "唯一兼容配件",
  }))
    await page.locator(`#${key}`).fill(value);
  await button(page, "＋ 添加明细").click();
  for (const [key, value] of Object.entries({
    name: "配件",
    specification: "标准型号",
    quantity: "0.125",
    unit: "批",
    unitPrice: "12",
  }))
    await page.locator(`#items-0-${key}`).fill(value);
  await button(page, "＋ 新增供应商报价").click();
  await page.locator("#quotes-0-supplierName").fill("唯一供应商");
  await page.locator("#quotes-0-quoteDate").fill("2028-01-01");
  await page.locator(".purchase-quote-evidence summary").click();
  await page.locator("#quotes-0-basis").fill("按清单核实，金额尚待最终确认");
  await page.getByLabel("选择供应商 *", { exact: true }).selectOption("0");
  await page.getByLabel("采用单一来源采购", { exact: true }).check();
  await button(page, "提交申请").click();
  await expect(page.locator("#singleSourceReason")).toBeFocused();
  await page.locator("#singleSourceReason").fill("仅此厂家配件兼容已有系统");
  await button(page, "提交申请").click();
  await shot(page, "confirm-mobile");
  await button(page, "确认提交").click();
  await submitted(page);
  await expect(
    page.getByText("单一来源采购 · 已提交单一来源说明", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("部分报价未填金额，无法判断最低价", { exact: true }),
  ).toBeVisible();
  const result = await detail(page, page.url().split("/").at(-1)!);
  expect(result.application.version).toBe(2);
  expect(result.workflow.routeSnapshot.selectedQuoteAmount).toBeNull();
  expect(result.application.totalAmount).toBe("1.50");
  await shot(page, "detail-mobile");
});

test("保存成功后提交被拒保留草稿，明确再次确认才能重试", async ({ page }) => {
  await login(page, "roster_03");
  const draft = await create(page, "提交失败草稿");
  await openDraft(page, draft);
  let submits = 0;
  await page.route(`**/purchase-drafts/${draft.id}/submit`, (route) => {
    submits++;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      json: {
        error: {
          code: "APPROVER_UNRESOLVED",
          message: "企业负责人必须恰有一名有效人员，请联系管理员核验授权",
        },
      },
    });
  });
  await page.locator("#title").fill("保存成功但未提交");
  await submit(page);
  await expect(page.locator(".notice-error")).toContainText("核验授权");
  await expect(page.locator("#title")).toHaveValue("保存成功但未提交");
  await expect(button(page, "提交申请")).toBeEnabled();
  const persisted = (
    await (await page.request.get(`/api/purchase-drafts/${draft.id}`)).json()
  ).data;
  expect(persisted.title).toBe("保存成功但未提交");
  expect(persisted.version).toBe(draft.version + 1);
  expect(submits).toBe(1);
  await page.unroute(`**/purchase-drafts/${draft.id}/submit`);
  await submit(page);
  await submitted(page);
  expect((await detail(page, draft.id)).application.version).toBe(
    draft.version + 2,
  );
});

test("采购提交响应丢失与双窗口竞争，停写并核对实际提交结果", async ({
  page,
  context,
}) => {
  await login(page, "roster_04");
  const draft = await create(page, "提交响应丢失");
  await openDraft(page, draft);
  const other = await context.newPage();
  await openDraft(other, draft);
  await other.locator("#title").fill("另一窗口未保存内容");
  let submits = 0;
  await page.route(`**/purchase-drafts/${draft.id}/submit`, async (route) => {
    submits++;
    await route.fetch();
    await route.abort();
  });
  await submit(page);
  await expect(button(page, "提交申请")).toBeDisabled();
  await expect(page.locator("#title")).toHaveValue(draft.title);
  expect(submits).toBe(1);
  expect((await detail(page, draft.id)).application.status).toBe("pending");
  await button(other, "保存草稿").click();
  await expect(button(other, "保存草稿")).toBeDisabled();
  await expect(other.locator("#title")).toHaveValue("另一窗口未保存内容");
  const popup = page.waitForEvent("popup");
  await page
    .getByRole("link", { name: "新窗口查看提交结果", exact: true })
    .click();
  const result = await popup;
  await submitted(result);
  await result.close();
  await other.close();
});

test("保存响应丢失时不得继续提交，服务端字段错误不冒充成功", async ({
  page,
}) => {
  await login(page, "roster_05");
  const draft = await create(page, "保存响应丢失");
  await openDraft(page, draft);
  let submits = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(`/purchase-drafts/${draft.id}/submit`))
      submits++;
  });
  await page.route(`**/api/purchase-drafts/${draft.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.locator("#title").fill("仍需核对的内容");
  await submit(page);
  await expect(button(page, "提交申请")).toBeDisabled();
  expect(submits).toBe(0);
  await expect(page.locator("#title")).toHaveValue("仍需核对的内容");
  await page.unroute(`**/api/purchase-drafts/${draft.id}`);
  page.once("dialog", (dialog) => dialog.accept());
  await button(page, "丢弃本地修改并重新加载").click();
  await expect(page.locator("#title")).toHaveValue("仍需核对的内容");
  await page.route(`**/purchase-drafts/${draft.id}/submit`, (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      json: {
        error: {
          code: "VALIDATION_ERROR",
          message: "输入字段不符合要求",
          fieldErrors: { quotes: ["报价附件已变化，请核对"] },
        },
      },
    }),
  );
  await submit(page);
  await expect(
    page.getByText("报价附件已变化，请核对", { exact: true }),
  ).toBeVisible();
  await expect(button(page, "提交申请")).toBeEnabled();
  expect(submits).toBe(1);
});

test("采购通知跳转与正文/文件权限、实际节点激活和终态刷新", async ({
  page,
  browser,
}) => {
  await login(page, "roster_06");
  const draft = await create(page, "采购通知权限");
  await openDraft(page, draft);
  await page.getByLabel("选择报价附件").setInputFiles({
    name: "权限凭据.png",
    mimeType: "image/png",
    buffer: await png(),
  });
  await expect(button(page, "预览 权限凭据.png")).toBeVisible();
  await submit(page);
  await submitted(page);
  const head = await actor(browser, "roster_20");
  const company = await actor(browser, "roster_19");
  const finance = await actor(browser, "roster_21");
  const admin = await actor(browser, "admin");
  try {
    for (const denied of [company.page, finance.page, admin.page]) {
      await denied.goto(`/purchase/applications/${draft.id}`);
      await expect(denied.locator(".notice-error")).toContainText("无权访问");
      await expect(
        denied.getByRole("heading", { name: draft.title, exact: true }),
      ).toHaveCount(0);
      expect(
        (
          await denied.request.get(
            `/api/purchase-applications/${draft.id}/attachments`,
          )
        ).status(),
      ).toBe(404);
    }
    const items: NotificationItem[] = (
      await (
        await head.page.request.get("/api/notifications?pageSize=100")
      ).json()
    ).data.items;
    const notification = items.find((item) => item.appId === draft.id)!;
    expect(notification.target?.type).toBe("purchase");
    await head.page.goto(`/notifications/${notification.id}`);
    const link = head.page.getByRole("link", {
      name: "查看申请详情",
      exact: true,
    });
    await expect(link).toHaveAttribute(
      "href",
      `/purchase/applications/${draft.id}`,
    );
    await link.click();
    await submitted(head.page);
    await button(head.page, "预览 权限凭据.png").click();
    await expect(head.page.getByRole("dialog").getByRole("img")).toBeVisible();
    await head.page.keyboard.press("Escape");
    await decide(head.page, draft.id, "approve");
    await button(company.page, "重新加载").click();
    await submitted(company.page);
    await decide(company.page, draft.id, "approve");
    await button(page, "刷新详情").click();
    await expect(
      page.getByText("已通过", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.locator(".travel-timeline").last().getByRole("listitem"),
    ).toHaveCount(3);
    await head.page.goto(`/notifications/${notification.id}`);
    await expect(
      head.page.getByText("原任务当前状态：已通过", { exact: false }),
    ).toBeVisible();
    await head.page
      .getByRole("link", { name: "查看申请详情", exact: true })
      .click();
    await submitted(head.page);
    const fresh = (
      await (
        await head.page.request.get(`/api/notifications/${notification.id}`)
      ).json()
    ).data;
    expect(fresh.readAt).toBeNull();
  } finally {
    await head.close();
    await company.close();
    await finance.close();
    await admin.close();
  }
});

test("详情读取版本变化、重试与驳回/撤回历史及匿名保护", async ({
  page,
  browser,
}) => {
  await page.goto(
    "/purchase/applications/00000000-0000-4000-8000-000000000001",
  );
  await expect(page).toHaveURL(/\/login/);
  await login(page, "roster_07");
  const draft = await create(page, "刷新与终态");
  await openDraft(page, draft);
  await submit(page);
  await submitted(page);
  await page.route(
    `**/purchase-applications/${draft.id}/attachments`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.version++;
      await route.fulfill({ response, json: body });
    },
  );
  await button(page, "刷新详情").click();
  await expect(
    page.getByText("读取期间申请状态已变化，请刷新后查看。", { exact: true }),
  ).toBeVisible();
  await page.unroute(`**/purchase-applications/${draft.id}/attachments`);
  await button(page, "重新加载").click();
  await submitted(page);
  const current = await detail(page, draft.id);
  expect(
    (
      await page.request.post(
        `/api/purchase-applications/${draft.id}/withdraw`,
        {
          headers,
          data: { version: current.application.version, opinion: "需求已取消" },
        },
      )
    ).status(),
  ).toBe(200);
  await button(page, "刷新详情").click();
  await expect(page.getByText("已撤回", { exact: true })).toBeVisible();
  await expect(page.getByText("需求已取消", { exact: true })).toBeVisible();
  await expect(page.getByText(/^已取消，未开始 · 取消时间：/)).toBeVisible();
  await expect(
    page.getByText("前一节点通过后开始", { exact: true }),
  ).toHaveCount(0);
  const second = await create(page, "驳回历史");
  await openDraft(page, second);
  await submit(page);
  await submitted(page);
  const head = await actor(browser, "roster_20");
  try {
    await decide(head.page, second.id, "reject");
  } finally {
    await head.close();
  }
  await page.reload();
  await expect(page.getByText("已驳回", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("采购审阅意见", { exact: true })).toBeVisible();
  await page.route(`**/api/purchase-applications/${second.id}`, (route) =>
    route.abort(),
  );
  await button(page, "刷新详情").click();
  await expect(page.locator(".notice-error")).toContainText("网络连接失败");
  await expect(
    page.getByRole("heading", { name: second.title, exact: true }),
  ).toHaveCount(0);
  await page.unroute(`**/api/purchase-applications/${second.id}`);
  await button(page, "重新加载").click();
  await submitted(page);
});
