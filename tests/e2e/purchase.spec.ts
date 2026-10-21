import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { PurchaseDraft } from "../../src/lib/purchase";
const origin = "http://127.0.0.1:3101";
const headers = { Origin: origin };
const input = {
  title: "实验室设备采购申请",
  reason: "为支持新项目研发，采购实验设备用于测试。",
  expectedDate: "2028-04-20",
  project: "实验室研发",
  budgetLimit: "20000.00",
  selectionReason: "综合价格、售后及交期选择供应商。",
  singleSource: false,
  items: [
    {
      name: "实验台",
      specification: "LJ-1200",
      quantity: "2",
      unit: "台",
      unitPrice: "3500",
    },
    {
      name: "显微镜",
      specification: "BX53",
      quantity: "1",
      unit: "台",
      unitPrice: "12000",
    },
  ],
  quotes: [
    {
      supplierName: "北京供应商",
      quoteDate: "2028-04-01",
      amount: "18500",
      basis: "含安装及一年保修",
      selected: true,
    },
    {
      supplierName: "上海供应商",
      quoteDate: "2028-04-02",
      amount: "19200",
      basis: "含运费",
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
  const response = await page.request.post("/api/purchase-drafts", {
    headers,
    data: { ...input, title },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as PurchaseDraft;
}
async function read(page: Page, id: string) {
  const response = await page.request.get(`/api/purchase-drafts/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as PurchaseDraft;
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/purchase-${name}.png`,
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
    .getByLabel("选择报价附件")
    .setInputFiles({ name, mimeType, buffer });
  await expect(
    page.getByRole("button", { name: `预览 ${name}`, exact: true }),
  ).toBeVisible();
}

test("采购填写与精确金额、稳定行 ID、报价附件绑定及原文件预览下载", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "roster_06");
  await page.getByRole("link", { name: "我的申请", exact: true }).click();
  await page.getByRole("link", { name: "采购草稿", exact: true }).click();
  await page.getByRole("link", { name: "＋ 新建采购申请" }).click();
  await expect(
    page.getByRole("heading", { name: "采购申请", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提交申请", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("选择报价附件")).toBeDisabled();
  await page.locator("#title").fill(input.title);
  await save(page);
  await expect(page).toHaveURL(/\/purchase\/drafts\/[a-f0-9-]+$/);
  const id = page.url().split("/").at(-1)!;
  for (const key of [
    "reason",
    "expectedDate",
    "project",
    "budgetLimit",
    "selectionReason",
  ] as const)
    await page.locator(`#${key}`).fill(input[key]);
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "＋ 添加明细", exact: true })
      .click();
    for (const [key, value] of Object.entries(input.items[i]))
      await page.locator(`#items-${i}-${key}`).fill(value);
    await page
      .getByRole("button", { name: "＋ 新增供应商报价", exact: true })
      .click();
    for (const key of ["supplierName", "quoteDate", "amount"] as const)
      await page.locator(`#quotes-${i}-${key}`).fill(input.quotes[i][key]);
    await page
      .locator(".purchase-quote-evidence")
      .nth(i)
      .locator("summary")
      .click();
    await page.locator(`#quotes-${i}-basis`).fill(input.quotes[i].basis);
    await page
      .locator(".purchase-quote-evidence")
      .nth(i)
      .locator("summary")
      .click();
  }
  await page.getByLabel("选择供应商 *", { exact: true }).selectOption("1");
  const evidence = page.locator(".purchase-quote-evidence").first();
  await evidence.locator("summary").click();
  await page.locator("#quotes-0-purchaseUrl").fill("javascript:alert(1)");
  await evidence.locator("summary").click();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator("#quotes-0-purchaseUrl")).toBeFocused();
  await page
    .locator("#quotes-0-purchaseUrl")
    .fill("https://example.invalid/quote");
  await page.getByLabel("线上报价 1", { exact: true }).check();
  await evidence.locator("summary").click();
  await page.locator("#items-0-quantity").fill("0.125");
  await page.locator("#items-0-unitPrice").fill("0.12");
  await expect(page.getByLabel("明细 1 金额", { exact: true })).toHaveText(
    "0.02",
  );
  await expect(
    page.getByText("预计总额：12000.02 元", { exact: true }),
  ).toBeVisible();
  await page.locator("#items-0-quantity").fill("1.0001");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator("#items-0-quantity")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#items-0-quantity")).toBeFocused();
  await page.locator("#items-0-quantity").fill("2");
  await page.locator("#items-0-unitPrice").fill("3500");
  await save(page);
  const saved = await read(page, id);
  expect(saved.totalAmount).toBe("19000.00");
  expect(saved.quotes[1].selected).toBe(true);
  await page.locator("#title").fill("附件操作时尚未保存的标题");
  const bytes = await png();
  await page
    .getByLabel("附件所属报价", { exact: true })
    .selectOption(saved.quotes[0].id);
  await upload(page, "报价.png", bytes);
  expect((await read(page, id)).title).toBe(input.title);
  await expect(page.locator("#title")).toHaveValue("附件操作时尚未保存的标题");
  await expect(
    page.getByRole("button", { name: "删除报价 1", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "预览 报价.png", exact: true })
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
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 报价.png", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("报价.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Purchase quote", { x: 40, y: 720 });
  pdf.addPage().drawText("Second page", { x: 40, y: 720 });
  await page
    .getByLabel("附件所属报价", { exact: true })
    .selectOption(saved.quotes[1].id);
  await upload(
    page,
    "报价.pdf",
    Buffer.from(await pdf.save()),
    "application/pdf",
  );
  await page
    .getByRole("button", { name: "预览 报价.pdf", exact: true })
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
  await page.locator("#title").fill(input.title);
  await save(page);
  await screenshot(page, "editor-desktop");
  const files = (
    await (
      await page.request.get(`/api/purchase-drafts/${id}/attachments`)
    ).json()
  ).data.items;
  expect(files.map((file: { quoteId: string }) => file.quoteId).sort()).toEqual(
    saved.quotes.map((quote) => quote.id).sort(),
  );
  await page
    .getByRole("button", { name: "删除 报价.png", exact: true })
    .click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除报价 1", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "删除 报价.png", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除报价 1", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "删除报价 1", exact: true }).click();
  await page.getByRole("button", { name: "删除明细 1", exact: true }).click();
  await save(page);
  await page.reload();
  await expect(page.locator("#quotes-0-supplierName")).toHaveValue(
    "上海供应商",
  );
  const remaining = await read(page, id);
  expect(remaining.quotes[0].id).toBe(saved.quotes[1].id);
  expect(remaining.quotes[0].selected).toBe(true);
  expect(remaining.items[0].id).toBe(saved.items[1].id);
  await expect(
    page.getByRole("button", { name: "预览 报价.pdf", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("采购双窗口冲突及保存响应丢失保留输入，不自动重试", async ({
  page,
  context,
}) => {
  await signIn(page, "roster_07");
  const draft = await create(page, "采购并发原稿");
  await page.goto(`/purchase/drafts/${draft.id}`);
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
  await other.route(`**/api/purchase-drafts/${draft.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
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

test("采购附件上传及删除响应丢失后停止写入，手动核对恢复", async ({ page }) => {
  await signIn(page, "roster_08");
  const draft = await create(page, "附件响应丢失");
  await page.goto(`/purchase/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
  let uploads = 0;
  await page.route("**/quotes/*/attachments", async (route) => {
    uploads++;
    await route.fetch();
    await route.abort();
  });
  await page.locator("#title").fill("未保存标题");
  await page.getByLabel("选择报价附件").setInputFiles({
    name: "不确定.png",
    mimeType: "image/png",
    buffer: await png(),
  });
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#title")).toHaveValue("未保存标题");
  expect(uploads).toBe(1);
  await page.unroute("**/quotes/*/attachments");
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
      await page.request.get(`/api/purchase-drafts/${draft.id}/attachments`)
    ).json()
  ).data;
  expect(list.items).toEqual([]);
  expect(list.version).toBe(draft.version + 2);
});

test("采购草稿分页搜索、离开保护、整单删除以及新建响应丢失", async ({
  page,
}) => {
  await signIn(page, "roster_09");
  for (let i = 0; i < 12; i++) await create(page, `采购分页 ${i}`);
  await page.goto("/purchase/drafts");
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByLabel("搜索", { exact: true }).fill("没有这个标题");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("没有符合条件的草稿")).toBeVisible();
  await page.getByLabel("搜索", { exact: true }).fill("采购分页 0");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByRole("link", { name: "继续填写" }).click();
  await expect(page.locator("#title")).toHaveValue("采购分页 0");
  const id = page.url().split("/").at(-1)!;
  await upload(page, "随草稿删除.png", await png());
  await page.locator("#title").fill("未保存输入");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "← 返回采购草稿" }).click();
  await expect(page.locator("#title")).toHaveValue("未保存输入");
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page).toHaveURL(/\/purchase\/drafts$/);
  expect((await page.request.get(`/api/purchase-drafts/${id}`)).status()).toBe(
    404,
  );
  await expect(page.getByText(/共 11 条/)).toBeVisible();
  await page.getByRole("link", { name: "＋ 新建采购申请" }).click();
  let writes = 0;
  await page.route("**/api/purchase-drafts", async (route) => {
    writes++;
    await route.fetch();
    await route.abort();
  });
  await page.locator("#title").fill("不确定的新建采购");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  await expect(page.locator("#title")).toHaveValue("不确定的新建采购");
  await expect(
    page.getByRole("link", { name: "新窗口查看服务器记录" }),
  ).toHaveAttribute("href", "/purchase/drafts");
  const list = (
    await (
      await page.request.get(
        "/api/purchase-drafts?keyword=" +
          encodeURIComponent("不确定的新建采购"),
      )
    ).json()
  ).data;
  expect(list.total).toBe(1);
});

test("采购手机表格内滚动、保存与报价附件预览，无页面溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "roster_10");
  const draft = await create(page, "手机采购草稿");
  await page.goto(`/purchase/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue(draft.title);
  await page.getByRole("button", { name: "＋ 添加明细", exact: true }).click();
  await page.locator("#items-2-name").fill("耗材");
  await page.locator("#items-2-quantity").fill("0.3");
  await page.locator("#items-2-unit").fill("盒");
  await page.locator("#items-2-unitPrice").fill("0.1");
  await expect(page.getByLabel("明细 3 金额", { exact: true })).toHaveText(
    "0.03",
  );
  await page.getByLabel("采用单一来源采购", { exact: true }).check();
  await page
    .locator("#singleSourceReason")
    .fill("仅兼容现有设备；草稿稍后整理报价。");
  await save(page);
  const persisted = await read(page, draft.id);
  expect(persisted.singleSource).toBe(true);
  expect(persisted.singleSourceReason).toContain("仅兼容现有设备");
  await upload(page, "手机报价.png", await png());
  await page.evaluate(() =>
    document.querySelectorAll(".table-scroll").forEach((element) => {
      element.scrollLeft = 0;
    }),
  );
  await screenshot(page, "editor-mobile");
  await page
    .getByRole("button", { name: "预览 手机报价.png", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
  await screenshot(page, "preview-mobile");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "← 返回采购草稿" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await screenshot(page, "list-mobile");
});

test("采购页面认证与本人隔离、加载版本变化、附件格式及读取错误", async ({
  page,
  browser,
}) => {
  await page.goto("/purchase/new");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "roster_11");
  const draft = await create(page, "权限采购");
  const other = await browser.newContext();
  try {
    const outsider = await other.newPage();
    await signIn(outsider, "admin");
    await outsider.goto(`/purchase/drafts/${draft.id}`);
    await expect(outsider.locator(".notice-error")).toBeVisible();
    await expect(outsider.locator("#title")).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.route(
    `**/api/purchase-drafts/${draft.id}/attachments`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.version++;
      await route.fulfill({ response, json: body });
    },
  );
  await page.goto(`/purchase/drafts/${draft.id}`);
  await expect(
    page.getByText("加载期间申请已变化，请重新加载。"),
  ).toBeVisible();
  await page.unroute(`**/api/purchase-drafts/${draft.id}/attachments`);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.locator("#title")).toHaveValue(draft.title);
  await page.getByLabel("选择报价附件").setInputFiles({
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
