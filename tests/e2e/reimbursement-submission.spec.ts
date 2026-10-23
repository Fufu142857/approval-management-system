import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { ReimbursementDraft } from "../../src/lib/reimbursement";
import type { ReimbursementDetail } from "../../src/lib/reimbursement-display";
import type { NotificationItem } from "../../src/lib/notifications";
import { businessActor as actor } from "./business-actor";
const headers = { Origin: "http://127.0.0.1:3101" };
const input = {
  title: "报销提交验收",
  description: "项目交流支出",
  independentReason: "未事先申请的必要支出",
  remarks: "提交后保留备注",
  items: [
    {
      category: "transport",
      expenseDate: "2028-02-29",
      purpose: "高铁",
      amount: "0.10",
      noReceipt: true,
      noReceiptReason: "票据遗失",
    },
    {
      category: "meals",
      expenseDate: "2028-03-01",
      purpose: "餐费",
      amount: "0.20",
      noReceipt: true,
      noReceiptReason: "未提供票据",
    },
  ],
};
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function create(
  page: Page,
  title: string,
  extra = {},
): Promise<ReimbursementDraft> {
  const response = await page.request.post("/api/reimbursement-drafts", {
    headers,
    data: { ...input, title, ...extra },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data;
}
async function detail(page: Page, id: string): Promise<ReimbursementDetail> {
  const response = await page.request.get(
    `/api/reimbursement-applications/${id}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function open(page: Page, draft: ReimbursementDraft) {
  await page.goto(`/reimbursement/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
}
async function confirm(page: Page) {
  await button(page, "提交申请").click();
  await expect(
    page.getByRole("dialog", { name: "确认提交报销申请" }),
  ).toBeVisible();
  await button(page, "确认提交").click();
}
async function readonly(page: Page) {
  await expect(page).toHaveURL(/\/reimbursement\/applications\/[a-f0-9-]+$/);
  await expect(
    page.getByRole("heading", { name: "审批进度", exact: true }),
  ).toBeVisible();
  for (const name of [
    "保存草稿",
    "提交申请",
    "通过",
    "驳回",
    "撤回申请",
    "复制重提",
  ])
    await expect(button(page, name)).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
}
async function submitApi(page: Page, draft: ReimbursementDraft) {
  const response = await page.request.post(
    `/api/reimbursement-drafts/${draft.id}/submit`,
    { headers, data: { version: draft.version } },
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data as ReimbursementDetail;
}
async function decide(
  page: Page,
  id: string,
  decision: "approve" | "reject",
  opinion = "报销审阅意见",
) {
  const before = await detail(page, id);
  const task = before.tasks.find((task) => task.status === "pending")!;
  const response = await page.request.post(
    `/api/reimbursement-applications/${id}/tasks/${task.id}/decision`,
    {
      headers,
      data: { version: before.application.version, decision, opinion },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data as ReimbursementDetail;
}
async function shot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/reimbursement-submission-${name}.png`,
    fullPage: true,
  });
}
async function receipt(
  page: Page,
  name: string,
  buffer: Buffer,
  mimeType: string,
) {
  await page
    .getByLabel("选择费用票据")
    .setInputFiles({ name, buffer, mimeType });
  await expect(button(page, `预览 ${name}`)).toBeVisible();
}

test("报销完整校验、取消确认、先保存最新版本并提交，逐行冻结票据与精确金额", async ({
  browser,
}) => {
  const owner = await actor(browser, "roster_04");
  const page = owner.page;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const draft = await create(page, "完整报销提交", {
      items: input.items.map((item) => ({ ...item, noReceipt: false })),
    });
    await open(page, draft);
    await page.locator("#title").fill("");
    await button(page, "提交申请").click();
    await expect(page.locator("#title")).toBeFocused();
    await page.locator("#title").fill("保存与提交最终标题");
    await page.locator("#independentReason").fill("");
    await button(page, "提交申请").click();
    await expect(page.locator("#independentReason")).toBeFocused();
    await page.locator("#independentReason").fill("最终独立说明");
    await page.locator("#items-0-expenseDate").fill("");
    await button(page, "提交申请").click();
    await expect(page.locator("#items-0-expenseDate")).toBeFocused();
    await page.locator("#items-0-expenseDate").fill("2028-02-29");
    await button(page, "提交申请").click();
    await expect(page.locator("#items-0")).toBeFocused();
    await expect(
      page.getByText(/请上传本明细票据，或明确选择无票并说明原因/).first(),
    ).toBeVisible();
    const png = await sharp({
      create: { width: 320, height: 180, channels: 3, background: "#dddddd" },
    })
      .png()
      .toBuffer();
    await page.locator("#receiptNumber").fill("RCPT-001");
    await receipt(page, "报销原票.png", png, "image/png");
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Reimbursement first page", { x: 40, y: 720 });
    pdf.addPage().drawText("Reimbursement second page", { x: 40, y: 720 });
    await receipt(
      page,
      "报销凭证.pdf",
      Buffer.from(await pdf.save()),
      "application/pdf",
    );
    // Files for the first row must not satisfy the second row's receipt requirement.
    await button(page, "提交申请").click();
    await expect(page.locator("#items-1")).toBeFocused();
    await page.getByLabel("费用 2 无票支出", { exact: true }).check();
    await page.locator("#items-1-noReceiptReason").fill("");
    await button(page, "提交申请").click();
    await expect(page.locator("#items-1-noReceiptReason")).toBeFocused();
    await page.locator("#items-1-noReceiptReason").fill("现场未开票");
    await page.locator("#attachmentItem").selectOption(draft.items[1].id);
    await receipt(
      page,
      "附加说明.jpg",
      await sharp(png).jpeg().toBuffer(),
      "image/jpeg",
    );
    await expect(
      page.getByLabel("费用 2 无票支出", { exact: true }),
    ).toBeChecked();
    const writes: {
      method: string;
      url: string;
      data: Record<string, unknown>;
    }[] = [];
    page.on("request", (request) => {
      if (
        ["POST", "PUT"].includes(request.method()) &&
        request.url().includes("reimbursement-drafts")
      )
        writes.push({
          method: request.method(),
          url: request.url(),
          data: request.postDataJSON(),
        });
    });
    await button(page, "提交申请").click();
    const dialog = page.getByRole("dialog", { name: "确认提交报销申请" });
    await expect(dialog.getByText("0.30 元", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("1 项（已填写原因）", { exact: true }),
    ).toBeVisible();
    await shot(page, "confirm-desktop");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(writes).toHaveLength(0);
    await confirm(page);
    await readonly(page);
    expect(writes.map((write) => write.method)).toEqual(["PUT", "POST"]);
    expect(writes[1].url).toContain("/submit");
    const after = await detail(page, draft.id);
    expect(writes[1].data).toEqual({ version: after.application.version - 1 });
    expect(after.application.title).toBe("保存与提交最终标题");
    expect(after.workflow.routeSnapshot.totalAmount).toBe("0.30");
    expect(after.workflow.routeSnapshot.noReceiptItems).toEqual([
      { id: draft.items[1].id, reason: "现场未开票" },
    ]);
    await expect(
      page.getByText("无票支出 1 项 · 请重点核对费用及无票原因"),
    ).toBeVisible();
    await expect(
      page.getByText("票据号码：RCPT-001", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/另有附加文件，无票声明仍保留/)).toBeVisible();
    await shot(page, "detail-desktop");
    const contentPath = `**/api/reimbursement-applications/${draft.id}/attachments/*/content`;
    await page.route(contentPath, (route) =>
      route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "原票暂不可读取" } },
      }),
    );
    await button(page, "预览 报销原票.png").click();
    await expect(
      page.getByText("原票暂不可读取", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.unroute(contentPath);
    await button(page, "预览 报销原票.png").click();
    await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
    await button(page, "关闭").click();
    const downloading = page.waitForEvent("download");
    await button(page, "下载 报销原票.png").click();
    const downloaded = await downloading;
    expect(await readFile((await downloaded.path())!)).toEqual(png);
    await button(page, "预览 报销凭证.pdf").click();
    await expect(page.locator("canvas")).toBeVisible();
    await button(page, "下一页").click();
    await expect(page.getByText("第 2 / 2 页", { exact: true })).toBeVisible();
    await shot(page, "pdf-desktop");
    await button(page, "关闭").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await button(page, "预览 附加说明.jpg").click();
    await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
    await shot(page, "receipt-mobile");
    await button(page, "关闭").click();
    await page.goto(`/reimbursement/drafts/${draft.id}`);
    await expect(
      page.getByRole("link", { name: "查看提交后详情", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#title")).toHaveCount(0);
    await page
      .getByRole("link", { name: "查看提交后详情", exact: true })
      .click();
    await readonly(page);
    expect(errors).toEqual([]);
  } finally {
    await owner.close();
  }
});

test("手机新建无票报销直接保存提交，确认与只读详情无水平溢出", async ({
  browser,
}) => {
  const owner = await actor(browser, "roster_05");
  const page = owner.page;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/reimbursement/new");
    await page.locator("#title").fill("手机直接提交报销");
    await page.locator("#description").fill(input.description);
    await page.locator("#independentReason").fill(input.independentReason);
    await button(page, "＋ 添加费用").click();
    await page.getByLabel("费用 1 类型").selectOption("transport");
    await page.locator("#items-0-expenseDate").fill("2028-02-29");
    await page.locator("#items-0-purpose").fill("市内交通");
    await page.locator("#items-0-amount").fill("0.1");
    await page.getByLabel("费用 1 无票支出", { exact: true }).check();
    await page.locator("#items-0-noReceiptReason").fill("未索取票据");
    await button(page, "提交申请").click();
    await shot(page, "confirm-mobile");
    await button(page, "确认提交").click();
    await readonly(page);
    const value = await detail(page, page.url().split("/").at(-1)!);
    expect(value.application.version).toBe(2);
    expect(value.application.totalAmount).toBe("0.10");
    await shot(page, "detail-mobile");
  } finally {
    await owner.close();
  }
});

test("保存响应丢失不继续提交；提交响应丢失停写并通过只读详情核对", async ({
  browser,
}) => {
  const owner = await actor(browser, "roster_06");
  const page = owner.page;
  try {
    const draft = await create(page, "报销未知保存响应");
    await open(page, draft);
    await page.locator("#title").fill("保留最新本地内容");
    let submits = 0,
      saves = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/submit")) submits++;
    });
    await page.route(
      `**/api/reimbursement-drafts/${draft.id}`,
      async (route) => {
        if (route.request().method() === "PUT") {
          saves++;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      },
    );
    await confirm(page);
    await expect(button(page, "提交申请")).toBeDisabled();
    await expect(page.locator("#title")).toHaveValue("保留最新本地内容");
    expect(saves).toBe(1);
    expect(submits).toBe(0);
    await page.unroute(`**/api/reimbursement-drafts/${draft.id}`);
    page.once("dialog", (dialog) => dialog.accept());
    await button(page, "丢弃本地修改并重新加载").click();
    await expect(page.locator("#title")).toHaveValue("保留最新本地内容");
    await page.route(
      `**/api/reimbursement-drafts/${draft.id}/submit`,
      async (route) => {
        await route.fetch();
        await route.abort();
      },
    );
    await confirm(page);
    await expect(button(page, "提交申请")).toBeDisabled();
    await expect(
      page.getByText("提交未确认完成，请核对错误说明和服务器记录。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(submits).toBe(1);
    expect((await detail(page, draft.id)).logs).toHaveLength(1);
    await shot(page, "uncertain-desktop");
    const popupWait = page.waitForEvent("popup");
    await page
      .getByRole("link", { name: "新窗口核对提交结果", exact: true })
      .click();
    const popup = await popupWait;
    await readonly(popup);
    await popup.close();
    expect(submits).toBe(1);
  } finally {
    await owner.close();
  }
});

test("提交版本竞争保留输入；审批人员配置失败保持草稿并显示服务端原因", async ({
  browser,
}) => {
  const owner = await actor(browser, "roster_07");
  const head = await actor(browser, "roster_20");
  try {
    const page = owner.page;
    const draft = await create(page, "报销提交版本竞争");
    await open(page, draft);
    await button(page, "提交申请").click();
    const replacement = await page.request.put(
      `/api/reimbursement-drafts/${draft.id}`,
      {
        headers,
        data: { ...input, title: "另一客户端已保存", version: draft.version },
      },
    );
    expect(replacement.status()).toBe(200);
    await button(page, "确认提交").click();
    await expect(button(page, "提交申请")).toBeDisabled();
    await expect(page.locator("#title")).toHaveValue(draft.title);
    expect(
      (
        await page.request.get(`/api/reimbursement-applications/${draft.id}`)
      ).status(),
    ).toBe(404);
    const own = await create(head.page, "审批人自审阻止");
    await open(head.page, own);
    await head.page.locator("#description").fill("已保存但未成功提交");
    await confirm(head.page);
    await expect(
      head.page.getByText("审批路径包含申请人本人，请联系管理员调整授权", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(head.page.locator("#description")).toHaveValue(
      "已保存但未成功提交",
    );
    const saved = (
      await (
        await head.page.request.get(`/api/reimbursement-drafts/${own.id}`)
      ).json()
    ).data;
    expect(saved.status).toBe("draft");
    expect(saved.version).toBe(2);
    await expect(button(head.page, "保存草稿")).toBeEnabled();
  } finally {
    await owner.close();
    await head.close();
  }
});

test("已批差旅采购摘要冻结，通知跳转与报销权限不扩展源单权限", async ({
  browser,
}) => {
  const owner = await actor(browser, "roster_08");
  const head = await actor(browser, "roster_20");
  const finance = await actor(browser, "roster_21");
  const company = await actor(browser, "roster_19");
  const outsider = await actor(browser, "roster_09");
  const admin = await actor(browser, "admin");
  try {
    const ids: string[] = [];
    for (const type of ["travel", "purchase"] as const) {
      const data =
        type === "travel"
          ? {
              title: "冻结差旅来源",
              departure: "杭州",
              destination: "上海",
              startDate: "2028-02-29",
              endDate: "2028-03-01",
              transportation: "高铁",
              budget: "100",
              purpose: "交流",
            }
          : {
              title: "冻结采购来源",
              reason: "设备",
              expectedDate: "2028-03-01",
              budgetLimit: "100",
              selectionReason: "适配",
              singleSource: true,
              singleSourceReason: "独家",
              items: [
                {
                  name: "设备",
                  specification: "A",
                  quantity: "1",
                  unit: "台",
                  unitPrice: "50.01",
                },
              ],
              quotes: [
                {
                  supplierName: "甲",
                  quoteDate: "2028-02-01",
                  amount: "50.01",
                  basis: "书面",
                  selected: true,
                },
              ],
            };
      const response = await owner.page.request.post(`/api/${type}-drafts`, {
        headers,
        data,
      });
      expect(response.status()).toBe(201);
      const draft = (await response.json()).data;
      ids.push(draft.id);
      let value = (
        await (
          await owner.page.request.post(
            `/api/${type}-drafts/${draft.id}/submit`,
            { headers, data: { version: draft.version } },
          )
        ).json()
      ).data;
      for (const approver of [head, type === "travel" ? finance : company]) {
        const task = value.tasks.find(
          (task: { status: string }) => task.status === "pending",
        );
        const decision = await approver.page.request.post(
          `/api/${type}-applications/${draft.id}/tasks/${task.id}/decision`,
          {
            headers,
            data: {
              version: value.application.version,
              decision: "approve",
              opinion: "",
            },
          },
        );
        expect(decision.status()).toBe(200);
        value = (await decision.json()).data;
      }
    }
    const draft = await create(owner.page, "多来源冻结报销", {
      linkedApplicationIds: ids,
      independentReason: "",
    });
    await open(owner.page, draft);
    await confirm(owner.page);
    await readonly(owner.page);
    const frozen = (await detail(owner.page, draft.id)).workflow.routeSnapshot;
    expect(frozen.linkedApplications).toHaveLength(2);
    await expect(
      owner.page.getByText("杭州 → 上海", { exact: true }),
    ).toBeVisible();
    await expect(
      owner.page.getByText("50.01 元", { exact: true }),
    ).toBeVisible();
    await shot(owner.page, "sources-desktop");
    for (const denied of [finance, outsider, admin]) {
      await denied.page.goto(`/reimbursement/applications/${draft.id}`);
      await expect(
        denied.page.getByText("申请不存在或无权访问", { exact: true }),
      ).toBeVisible();
      await expect(
        denied.page.getByRole("heading", { name: draft.title, exact: true }),
      ).toHaveCount(0);
      expect(
        (
          await denied.page.request.get(
            `/api/reimbursement-applications/${draft.id}/attachments`,
          )
        ).status(),
      ).toBe(404);
    }
    const notifications = (
      await (
        await head.page.request.get("/api/notifications?pageSize=100")
      ).json()
    ).data.items as NotificationItem[];
    const notification = notifications.find(
      (item) => item.target?.id === draft.id,
    )!;
    expect(notification).toBeTruthy();
    await head.page.goto(`/notifications/${notification.id}`);
    await head.page
      .getByRole("link", { name: "查看申请详情", exact: true })
      .click();
    await readonly(head.page);
    expect(
      (
        await (
          await head.page.request.get(`/api/notifications/${notification.id}`)
        ).json()
      ).data.readAt,
    ).toBeNull();
    await decide(head.page, draft.id, "approve");
    await finance.page.goto(`/reimbursement/applications/${draft.id}`);
    await readonly(finance.page);
    await expect(
      finance.page.getByText("50.01 元", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await finance.page.request.get(`/api/purchase-applications/${ids[1]}`)
      ).status(),
    ).toBe(404);
    await expect(finance.page.locator(`a[href*="${ids[1]}"]`)).toHaveCount(0);
    expect(
      (await detail(finance.page, draft.id)).workflow.routeSnapshot,
    ).toEqual(frozen);
  } finally {
    for (const person of [owner, head, finance, company, outsider, admin])
      await person.close();
  }
});

test("详情读取失败和版本状态不一致隐藏旧正文；匿名与错误类型隔离", async ({
  browser,
  page,
}) => {
  const owner = await actor(browser, "roster_10");
  try {
    const draft = await create(owner.page, "报销读取一致性");
    await submitApi(owner.page, draft);
    await page.goto(`/reimbursement/applications/${draft.id}`);
    await expect(page).toHaveURL(/\/login/);
    await owner.page.goto(`/reimbursement/applications/${draft.id}`);
    await readonly(owner.page);
    const path = `**/api/reimbursement-applications/${draft.id}/attachments`;
    await owner.page.route(path, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.version += 1;
      await route.fulfill({ response, json: body });
    });
    await button(owner.page, "刷新详情").click();
    await expect(
      owner.page.getByText("读取期间申请状态已变化，请刷新后查看。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      owner.page.getByRole("heading", { name: draft.title, exact: true }),
    ).toHaveCount(0);
    await owner.page.unroute(path);
    await owner.page.route(path, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "TEST_FAILURE", message: "票据读取暂时失败" } },
      }),
    );
    await button(owner.page, "重新加载").click();
    await expect(
      owner.page.getByText("票据读取暂时失败", { exact: true }),
    ).toBeVisible();
    await expect(
      owner.page.getByRole("heading", { name: draft.title, exact: true }),
    ).toHaveCount(0);
    await owner.page.unroute(path);
    await owner.page.route(path, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.status = "withdrawn";
      await route.fulfill({ response, json: body });
    });
    await button(owner.page, "重新加载").click();
    await expect(
      owner.page.getByText("读取期间申请状态已变化，请刷新后查看。", {
        exact: true,
      }),
    ).toBeVisible();
    await owner.page.unroute(path);
    await button(owner.page, "重新加载").click();
    await readonly(owner.page);
    const travel = (
      await (
        await owner.page.request.post("/api/travel-drafts", {
          headers,
          data: { title: "其他业务" },
        })
      ).json()
    ).data;
    try {
      await owner.page.goto(`/reimbursement/applications/${travel.id}`);
      await expect(
        owner.page.getByText("申请不存在或无权访问", { exact: true }),
      ).toBeVisible();
    } finally {
      // This cross-business fixture must not affect the later travel pagination case.
      const removed = await owner.page.request.delete(
        `/api/travel-drafts/${travel.id}`,
        {
          headers,
          data: { version: travel.version },
        },
      );
      expect(removed.status()).toBe(200);
    }
  } finally {
    await owner.close();
  }
});

test("通过、驳回与撤回终态刷新保留冻结内容、历史意见和取消节点", async ({
  browser,
}) => {
  const owner = await actor(browser, "roster_11");
  const head = await actor(browser, "roster_20");
  const finance = await actor(browser, "roster_21");
  try {
    for (const outcome of ["approved", "rejected", "withdrawn"] as const) {
      const draft = await create(owner.page, `报销终态-${outcome}`);
      const initial = await submitApi(owner.page, draft);
      await owner.page.goto(`/reimbursement/applications/${draft.id}`);
      await readonly(owner.page);
      if (outcome === "approved") {
        await decide(head.page, draft.id, "approve");
        await decide(finance.page, draft.id, "approve", "财务最终通过");
      } else if (outcome === "rejected")
        await decide(head.page, draft.id, "reject", "请补充费用依据");
      else {
        const response = await owner.page.request.post(
          `/api/reimbursement-applications/${draft.id}/withdraw`,
          {
            headers,
            data: {
              version: initial.application.version,
              opinion: "本人取消报销",
            },
          },
        );
        expect(response.status()).toBe(200);
      }
      await button(owner.page, "刷新详情").click();
      await expect(
        owner.page.getByText(
          outcome === "approved"
            ? "财务最终通过"
            : outcome === "rejected"
              ? "请补充费用依据"
              : "本人取消报销",
          { exact: true },
        ),
      ).toBeVisible();
      const after = await detail(owner.page, draft.id);
      expect(after.application.status).toBe(outcome);
      expect(after.workflow.routeSnapshot).toEqual(
        initial.workflow.routeSnapshot,
      );
      if (outcome !== "approved")
        await expect(
          owner.page.getByText(/已取消，未开始 · 取消时间/),
        ).toBeVisible();
      await head.page.goto(`/reimbursement/applications/${draft.id}`);
      await readonly(head.page);
      if (outcome === "withdrawn") await shot(owner.page, "withdrawn-desktop");
    }
  } finally {
    await owner.close();
    await head.close();
    await finance.close();
  }
});
