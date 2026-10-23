import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { ReimbursementDraft } from "../../src/lib/reimbursement";
import { businessActor } from "./business-actor";
const headers = { Origin: "http://127.0.0.1:3101" };
const input = {
  title: "差旅费用报销",
  description: "项目交流费用",
  independentReason: "独立支出",
  remarks: "费用备注",
  items: [
    {
      category: "transport",
      expenseDate: "2028-02-29",
      purpose: "高铁",
      amount: "0.10",
      noReceipt: false,
      noReceiptReason: "",
    },
    {
      category: "lodging",
      expenseDate: "2028-02-29",
      purpose: "住宿",
      amount: "0.20",
      noReceipt: false,
      noReceiptReason: "",
    },
    {
      category: "meals",
      expenseDate: "2028-03-01",
      purpose: "餐费",
      amount: "1.23",
      noReceipt: true,
      noReceiptReason: "票据遗失",
    },
  ],
};
async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function create(page: Page, title: string) {
  const response = await page.request.post("/api/reimbursement-drafts", {
    headers,
    data: { ...input, title },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as ReimbursementDraft;
}
async function read(page: Page, id: string) {
  const response = await page.request.get(`/api/reimbursement-drafts/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as ReimbursementDraft;
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/reimbursement-${name}.png`,
    fullPage: true,
  });
}
async function png() {
  return sharp({
    create: { width: 320, height: 180, channels: 3, background: "#eeeeee" },
  })
    .png()
    .toBuffer();
}
async function upload(
  page: Page,
  name: string,
  buffer: Buffer,
  mimeType = "image/png",
) {
  await page
    .getByLabel("选择费用票据")
    .setInputFiles({ name, mimeType, buffer });
  await expect(
    page.getByRole("button", { name: `预览 ${name}`, exact: true }),
  ).toBeVisible();
}
test("报销双窗口冲突及保存响应丢失保留输入，不自动重试", async ({
  page,
  context,
}) => {
  await signIn(page, "roster_07");
  const draft = await create(page, "报销并发原稿");
  await page.goto(`/reimbursement/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.locator("#title")).toHaveValue(draft.title);
  await page.locator("#title").fill("第一窗口");
  await save(page);
  await other.locator("#title").fill("第二窗口本地内容");
  await other.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await expect(other.locator("#title")).toHaveValue("第二窗口本地内容");
  await screenshot(other, "conflict-desktop");
  other.once("dialog", (dialog) => dialog.accept());
  await other.getByRole("button", { name: "丢弃本地修改并重新加载" }).click();
  await expect(other.locator("#title")).toHaveValue("第一窗口");
  let writes = 0;
  await other.route(
    `**/api/reimbursement-drafts/${draft.id}`,
    async (route) => {
      if (route.request().method() === "PUT") {
        writes++;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    },
  );
  await other.locator("#title").fill("已保存但响应丢失");
  await other.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await expect(other.locator("#title")).toHaveValue("已保存但响应丢失");
  expect((await read(page, draft.id)).title).toBe("已保存但响应丢失");
  expect(writes).toBe(1);
  await other.close();
});

test("报销附件上传及删除响应丢失后停止写入，手动核对恢复", async ({ page }) => {
  await signIn(page, "roster_08");
  const draft = await create(page, "附件响应丢失");
  await page.goto(`/reimbursement/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
  let uploads = 0;
  await page.route("**/items/*/attachments", async (route) => {
    uploads++;
    await route.fetch();
    await route.abort();
  });
  await page.locator("#title").fill("未保存标题");
  await page.getByLabel("选择费用票据").setInputFiles({
    name: "不确定.png",
    mimeType: "image/png",
    buffer: await png(),
  });
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#title")).toHaveValue("未保存标题");
  expect(uploads).toBe(1);
  await page.unroute("**/items/*/attachments");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "丢弃本地修改并重新加载" }).click();
  await expect(
    page.getByRole("button", { name: "预览 不确定.png", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#title")).toHaveValue(draft.title);
  let deletes = 0;
  await page.route("**/attachments/*", async (route) => {
    if (route.request().method() === "DELETE") {
      deletes++;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "删除 不确定.png", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  expect(deletes).toBe(1);
  const list = (
    await (
      await page.request.get(
        `/api/reimbursement-drafts/${draft.id}/attachments`,
      )
    ).json()
  ).data;
  expect(list.items).toEqual([]);
  expect(list.version).toBe(draft.version + 2);
});

test("报销草稿分页搜索、离开保护、整单删除以及新建响应丢失", async ({
  page,
}) => {
  await signIn(page, "roster_09");
  for (let i = 0; i < 12; i++) await create(page, `报销分页 ${i}`);
  await page.goto("/reimbursement/drafts");
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByLabel("搜索", { exact: true }).fill("没有这个标题");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("没有符合条件的草稿")).toBeVisible();
  await page.getByLabel("搜索", { exact: true }).fill("报销分页 0");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByRole("link", { name: "继续填写" }).click();
  await expect(page.locator("#title")).toHaveValue("报销分页 0");
  const id = page.url().split("/").at(-1)!;
  await upload(page, "随草稿删除.png", await png());
  await page.locator("#title").fill("未保存输入");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "← 返回报销草稿" }).click();
  await expect(page.locator("#title")).toHaveValue("未保存输入");
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page).toHaveURL(/\/reimbursement\/drafts$/);
  expect(
    (await page.request.get(`/api/reimbursement-drafts/${id}`)).status(),
  ).toBe(404);
  await expect(page.getByText(/共 11 条/)).toBeVisible();
  await page.getByRole("link", { name: "＋ 新建报销申请" }).click();
  let writes = 0;
  await page.route("**/api/reimbursement-drafts", async (route) => {
    writes++;
    await route.fetch();
    await route.abort();
  });
  await page.locator("#title").fill("不确定的新建报销");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  await expect(page.locator("#title")).toHaveValue("不确定的新建报销");
  await expect(
    page.getByRole("link", { name: "新窗口查看服务器记录" }),
  ).toHaveAttribute("href", "/reimbursement/drafts");
  const list = (
    await (
      await page.request.get(
        "/api/reimbursement-drafts?keyword=" +
          encodeURIComponent("不确定的新建报销"),
      )
    ).json()
  ).data;
  expect(list.total).toBe(1);
});

test("报销页面认证与本人隔离、加载版本变化、附件格式及读取错误", async ({
  page,
  browser,
}) => {
  await page.goto("/reimbursement/new");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "roster_11");
  const draft = await create(page, "权限报销");
  const other = await browser.newContext();
  try {
    const outsider = await other.newPage();
    await signIn(outsider, "admin");
    await outsider.goto(`/reimbursement/drafts/${draft.id}`);
    await expect(outsider.locator(".notice-error")).toBeVisible();
    await expect(outsider.locator("#title")).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.route(
    `**/api/reimbursement-drafts/${draft.id}/attachments`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.version++;
      await route.fulfill({ response, json: body });
    },
  );
  await page.goto(`/reimbursement/drafts/${draft.id}`);
  await expect(
    page.getByText("加载期间申请已变化，请重新加载。"),
  ).toBeVisible();
  await page.unroute(`**/api/reimbursement-drafts/${draft.id}/attachments`);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.locator("#title")).toHaveValue(draft.title);
  await page.getByLabel("选择费用票据").setInputFiles({
    name: "伪装.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator(".notice-error")).toContainText("仅支持真实");
  await upload(page, "权限.png", await png());
  await page.route("**/attachments/*/content", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "ATTACHMENT_UNAVAILABLE",
          message: "附件缺失或完整性校验失败",
        },
      }),
    }),
  );
  await page
    .getByRole("button", { name: "预览 权限.png", exact: true })
    .click();
  await expect(page.locator(".notice-error")).toContainText("附件缺失");
});

test("报销三条费用、五类选项、精确合计与稳定行排序；票据号码、原字节及 PDF 预览", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "roster_06");
  await page.getByRole("link", { name: "我的申请", exact: true }).click();
  await page.getByRole("link", { name: "报销草稿", exact: true }).click();
  await page.getByRole("link", { name: "＋ 新建报销申请" }).click();
  await expect(
    page.getByRole("heading", { name: "报销申请", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提交申请", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("选择费用票据")).toBeDisabled();
  await page.locator("#title").fill(input.title);
  for (const key of ["description", "independentReason", "remarks"] as const)
    await page.locator(`#${key}`).fill(input[key]);
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole("button", { name: "＋ 添加费用", exact: true })
      .click();
    await page
      .locator(`#items-${i}-category`)
      .selectOption(input.items[i].category);
    for (const key of ["expenseDate", "purpose", "amount"] as const)
      await page.locator(`#items-${i}-${key}`).fill(input.items[i][key]);
  }
  await expect(page.locator("#items-0-category option")).toHaveText([
    "请选择",
    "交通",
    "住宿",
    "餐饮",
    "办公",
    "其他",
  ]);
  await page.getByLabel("费用 3 无票支出", { exact: true }).check();
  await page.getByLabel("费用 3 无票原因", { exact: true }).fill("票据遗失");
  await expect(
    page.getByText("报销合计：1.53 元 · 无票支出 1 项", { exact: true }),
  ).toBeVisible();
  await page.locator("#items-0-amount").fill("0.001");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator("#items-0-amount")).toBeFocused();
  await expect(page.locator("#items-0-amount")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.locator("#items-0-amount").fill("0.10");
  await save(page);
  await expect(page).toHaveURL(/\/reimbursement\/drafts\/[a-f0-9-]+$/);
  const id = page.url().split("/").at(-1)!;
  const saved = await read(page, id);
  expect(saved.totalAmount).toBe("1.53");
  expect(saved.noReceiptCount).toBe(1);
  await page.locator("#title").fill("票据上传期间未保存标题");
  await page
    .getByLabel("票据所属费用", { exact: true })
    .selectOption(saved.items[0].id);
  await page
    .getByLabel("票据号码（选填）", { exact: true })
    .fill(" RECEIPT-001 ");
  const bytes = await png();
  await upload(page, "交通票据.png", bytes);
  await expect(
    page.getByText("票据号码：RECEIPT-001", { exact: true }),
  ).toBeVisible();
  expect((await read(page, id)).title).toBe(input.title);
  await expect(page.locator("#title")).toHaveValue("票据上传期间未保存标题");
  await expect(
    page.getByRole("button", { name: "删除费用 1", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "下移费用 1", exact: true }).click();
  await page
    .getByRole("button", { name: "预览 交通票据.png", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(320);
  await page.keyboard.press("Escape");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 交通票据.png", exact: true })
    .click();
  const download = await downloading;
  const chunks: Buffer[] = [];
  for await (const chunk of (await download.createReadStream())!)
    chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Receipt first page", { x: 40, y: 720 });
  pdf.addPage().drawText("Receipt second page", { x: 40, y: 720 });
  await page
    .getByLabel("票据所属费用", { exact: true })
    .selectOption(saved.items[1].id);
  await upload(
    page,
    "住宿票据.pdf",
    Buffer.from(await pdf.save()),
    "application/pdf",
  );
  await page
    .getByRole("button", { name: "预览 住宿票据.pdf", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "PDF 第 1 页", exact: true }),
  ).toHaveAttribute("data-rendered", "true");
  await page
    .getByRole("navigation", { name: "PDF 翻页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(
    page.getByRole("img", { name: "PDF 第 2 页", exact: true }),
  ).toHaveAttribute("data-rendered", "true");
  await screenshot(page, "pdf-desktop");
  await page.keyboard.press("Escape");
  await page
    .getByLabel("票据所属费用", { exact: true })
    .selectOption(saved.items[2].id);
  await upload(
    page,
    "餐费票据.jpg",
    await sharp(bytes).jpeg().toBuffer(),
    "image/jpeg",
  );
  await expect(
    page.getByLabel("费用 3 无票支出", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByText("已有票据，请核对无票标记。", { exact: true }),
  ).toBeVisible();
  const receiptList = (
    await (
      await page.request.get(`/api/reimbursement-drafts/${id}/attachments`)
    ).json()
  ).data.items;
  expect(
    receiptList.map((file: { itemId: string }) => file.itemId).sort(),
  ).toEqual(saved.items.map((item) => item.id).sort());
  expect(
    receiptList.find(
      (file: { originalName: string }) => file.originalName === "交通票据.png",
    ).receiptNumber,
  ).toBe("RECEIPT-001");
  await page.locator("#title").fill(input.title);
  await save(page);
  const ordered = await read(page, id);
  expect(ordered.items.map((row) => row.id)).toEqual([
    saved.items[1].id,
    saved.items[0].id,
    saved.items[2].id,
  ]);
  await screenshot(page, "editor-desktop");
  await page
    .getByRole("button", { name: "删除 交通票据.png", exact: true })
    .click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除费用 2", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "删除 交通票据.png", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除费用 2", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "删除费用 2", exact: true }).click();
  await save(page);
  await page.reload();
  await expect(page.locator("#items-0-purpose")).toHaveValue("住宿");
  expect((await read(page, id)).items.map((row) => row.id)).toEqual([
    saved.items[1].id,
    saved.items[2].id,
  ]);
  expect(errors).toEqual([]);
});

test("报销手机填写、票据预览与草稿列表无页面溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "roster_10");
  const draft = await create(page, "手机报销草稿");
  await page.goto(`/reimbursement/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
  await page.getByRole("button", { name: "＋ 添加费用", exact: true }).click();
  await page.locator("#items-3-purpose").fill("办公耗材");
  await page.locator("#items-3-category").selectOption("office");
  await page.locator("#items-3-amount").fill("0.1");
  await page.getByLabel("费用 4 无票支出", { exact: true }).check();
  await page
    .getByLabel("费用 4 无票原因", { exact: true })
    .fill("无票支出说明");
  await save(page);
  expect((await read(page, draft.id)).totalAmount).toBe("1.63");
  await upload(page, "手机票据.png", await png());
  await page.evaluate(() =>
    document.querySelectorAll(".table-scroll").forEach((element) => {
      element.scrollLeft = 0;
    }),
  );
  await screenshot(page, "editor-mobile");
  await page
    .getByRole("button", { name: "预览 手机票据.png", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
  await screenshot(page, "preview-mobile");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "← 返回报销草稿" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await screenshot(page, "list-mobile");
});

test("本人已批来源分页选择跨页保留、取消关联与独立报销，查询不会保存表单", async ({
  browser,
}) => {
  const owner = await businessActor(browser, "roster_16");
  const head = await businessActor(browser, "roster_20");
  const finance = await businessActor(browser, "roster_21");
  const company = await businessActor(browser, "roster_19");
  const { page } = owner;
  const ids: string[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const type = i === 0 ? "purchase" : "travel";
      const response = await page.request.post(`/api/${type}-drafts`, {
        headers,
        data:
          type === "travel"
            ? {
                title: `报销来源行程-${i}`,
                departure: "杭州",
                destination: "上海",
                startDate: "2028-02-29",
                endDate: "2028-03-01",
                transportation: "高铁",
                budget: "100",
                purpose: "项目交流",
              }
            : {
                title: "报销来源采购",
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
                    unitPrice: "50",
                  },
                ],
                quotes: [
                  {
                    supplierName: "甲",
                    quoteDate: "2028-02-01",
                    amount: "50",
                    basis: "书面",
                    selected: true,
                  },
                ],
              },
      });
      expect(response.status()).toBe(201);
      const saved = (await response.json()).data;
      ids.push(saved.id);
      const submission = await page.request.post(
        `/api/${type}-drafts/${saved.id}/submit`,
        { headers, data: { version: 1 } },
      );
      expect(submission.status()).toBe(200);
      let detail = (await submission.json()).data;
      for (const actor of [head, type === "travel" ? finance : company]) {
        const task = detail.tasks.find(
          (task: { status: string }) => task.status === "pending",
        );
        const decision = await actor.page.request.post(
          `/api/${type}-applications/${saved.id}/tasks/${task.id}/decision`,
          {
            headers,
            data: {
              version: detail.application.version,
              decision: "approve",
              opinion: "",
            },
          },
        );
        expect(decision.status()).toBe(200);
        detail = (await decision.json()).data;
      }
    }
    await page.route("**/api/reimbursement-link-options?*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "TEST_UNAVAILABLE", message: "来源读取暂不可用" },
        }),
      }),
    );
    await page.goto("/reimbursement/new");
    await page.locator("#title").fill("关联多单报销");
    let saves = 0;
    page.on("request", (request) => {
      if (
        ["POST", "PUT"].includes(request.method()) &&
        request.url().includes("reimbursement-drafts")
      )
        saves++;
    });
    const sources = page.getByRole("region", { name: "关联申请", exact: true });
    await expect(
      sources.getByText("来源读取暂不可用", { exact: true }),
    ).toBeVisible();
    await page.unroute("**/api/reimbursement-link-options?*");
    await sources
      .getByRole("button", { name: "重新加载", exact: true })
      .click();
    await expect(sources.getByRole("checkbox")).toHaveCount(5);
    await sources.getByRole("checkbox").first().check();
    await sources.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(sources.getByRole("checkbox")).toHaveCount(1);
    await sources.getByRole("checkbox").first().check();
    await expect(
      page.getByRole("heading", { name: "已选关联申请（2/20）", exact: true }),
    ).toBeVisible();
    await page.getByLabel("来源类型", { exact: true }).selectOption("purchase");
    await expect(sources.getByRole("checkbox")).toHaveCount(1);
    await expect(sources.getByRole("checkbox").first()).toBeChecked();
    await page.getByLabel("搜索已批申请", { exact: true }).fill("不存在");
    await page.getByRole("button", { name: "查询来源", exact: true }).click();
    await expect(
      page.getByText("没有符合条件的本人已批准申请；可填写独立报销说明。"),
    ).toBeVisible();
    expect(saves).toBe(0);
    await save(page);
    const id = page.url().split("/").at(-1)!;
    let value = await read(page, id);
    expect(value.linkedApplicationIds).toHaveLength(2);
    expect(value.linkedApplicationIds).toContain(ids[0]);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "已选关联申请（2/20）", exact: true }),
    ).toBeVisible();
    await screenshot(page, "sources-desktop");
    for (let i = 0; i < 2; i++)
      await page
        .getByRole("button", { name: /^取消关联 / })
        .first()
        .click();
    await page.locator("#independentReason").fill("改为独立支出");
    await save(page);
    value = await read(page, id);
    expect(value.linkedApplicationIds).toEqual([]);
    expect(value.independentReason).toBe("改为独立支出");
    expect(
      (await page.request.get(`/api/purchase-applications/${ids[0]}`)).status(),
    ).toBe(200);
  } finally {
    await Promise.all([
      owner.close(),
      head.close(),
      finance.close(),
      company.close(),
    ]);
  }
});
