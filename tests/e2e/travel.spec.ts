import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

const password = "Browser-test-password";
const origin = "http://127.0.0.1:3101";
const complete = {
  title: "浏览器差旅申请",
  departure: "杭州",
  destination: "上海",
  startDate: "2028-02-28",
  endDate: "2028-03-01",
  purpose: "客户交流",
  companions: "李四",
  transportation: "高铁",
  budget: "1234.56",
  remarks: "提前安排车票",
};
async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function create(page: Page, title: string) {
  const response = await page.request.post("/api/travel-drafts", {
    headers: { Origin: origin },
    data: { ...complete, title },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as { id: string; version: number };
}
async function fillComplete(page: Page) {
  for (const [key, value] of Object.entries(complete))
    await page.locator(`#${key}`).fill(value);
}
async function screenshot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/travel-${name}.png`,
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

test("差旅草稿填写、校验、附件预览下载删除、提交及只读详情", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "roster_01");
  await page.getByRole("link", { name: "我的申请", exact: true }).click();
  await expect(page.getByText("暂无差旅草稿，点击新建开始填写")).toBeVisible();
  await page.getByRole("link", { name: "＋ 新建差旅申请" }).click();
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(page.locator("#title")).toBeFocused();
  await page.locator("#title").fill("未完成行程");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page).toHaveURL(/\/travel\/drafts\/[a-f0-9-]+$/);
  const draftUrl = page.url();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("未完成行程");
  await fillComplete(page);
  await expect(
    page.getByText("出差天数：3 天", { exact: false }),
  ).toBeVisible();
  await page.locator("#budget").fill("-1");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(page.locator("#budget")).toHaveAttribute("aria-invalid", "true");
  await page.locator("#budget").fill(complete.budget);
  await page.locator("#endDate").fill("2028-02-27");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("结束日期不能早于开始日期", { exact: true }),
  ).toBeVisible();
  await page.locator("#endDate").fill(complete.endDate);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  const bytes = await png();
  await page
    .getByLabel("选择补充附件")
    .setInputFiles({ name: "行程.png", mimeType: "image/png", buffer: bytes });
  await expect(
    page.getByText("附件已上传；表单中未保存的修改仍需保存。"),
  ).toBeVisible();
  await screenshot(page, "editor-desktop");
  await page
    .getByRole("button", { name: "预览 行程.png", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "预览：行程.png" });
  await expect(preview.getByRole("img")).toBeVisible();
  await expect
    .poll(() =>
      preview
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(320);
  await screenshot(page, "preview-desktop");
  await page.keyboard.press("Escape");
  await expect(preview).not.toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 行程.png", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("行程.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const part of stream!) chunks.push(part);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  await page
    .getByRole("button", { name: "删除 行程.png", exact: true })
    .click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "预览 行程.png" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "删除 行程.png", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("附件已删除。", { exact: true })).toBeVisible();
  const pdf = await PDFDocument.create();
  pdf
    .addPage()
    .drawText("Travel attachment preview", { x: 40, y: 720, size: 20 });
  pdf.addPage().drawText("Second page", { x: 40, y: 720, size: 20 });
  await page.getByLabel("选择补充附件").setInputFiles({
    name: "说明.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(
    page.getByRole("button", { name: "预览 说明.pdf", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "预览 说明.pdf", exact: true })
    .click();
  const pdfCanvas = page.getByRole("img", { name: "PDF 第 1 页", exact: true });
  await expect(pdfCanvas).toHaveAttribute("data-rendered", "true");
  expect(
    await pdfCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      return data.some((value, index) => index % 4 !== 3 && value < 100);
    }),
  ).toBe(true);
  await expect(
    page.getByRole("navigation", { name: "PDF 翻页" }),
  ).toContainText("第 1 / 2 页");
  await screenshot(page, "pdf-preview-desktop");
  await page
    .getByRole("navigation", { name: "PDF 翻页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(
    page.getByRole("img", { name: "PDF 第 2 页", exact: true }),
  ).toHaveAttribute("data-rendered", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(draftUrl);
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(page).toHaveURL(/\/travel\/applications\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { name: "审批进度" })).toBeVisible();
  await expect(page.getByText("审批中", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("1234.56 元", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存草稿" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "预览 说明.pdf" }),
  ).toBeVisible();
  await screenshot(page, "detail-desktop");
  await page.reload();
  await expect(page.getByText("浏览器差旅申请", { exact: true })).toBeVisible();
  await page.goto(draftUrl);
  await expect(page.locator(".notice-error")).toContainText("已不是草稿");
  await page.getByRole("link", { name: "查看已提交申请" }).click();
  await expect(page.getByRole("heading", { name: "审批进度" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("双窗口版本冲突和响应丢失保留输入、不重复写入", async ({
  page,
  context,
}) => {
  await signIn(page, "roster_02");
  const draft = await create(page, "并发原稿");
  await page.goto(`/travel/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue("并发原稿");
  const other = await context.newPage();
  await other.goto(`/travel/drafts/${draft.id}`);
  await expect(other.locator("#title")).toHaveValue("并发原稿");
  await page.locator("#title").fill("第一窗口保存");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  await other.locator("#title").fill("第二窗口未保存");
  await other.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(other.locator(".notice-error").first()).toContainText(
    "已被修改",
  );
  await expect(other.locator("#title")).toHaveValue("第二窗口未保存");
  await expect(
    other.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await screenshot(other, "conflict-desktop");
  other.once("dialog", (dialog) => dialog.accept());
  await other.getByRole("button", { name: "丢弃本地修改并重新加载" }).click();
  await expect(other.locator("#title")).toHaveValue("第一窗口保存");
  let writes = 0;
  await other.route(`**/api/travel-drafts/${draft.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await other.locator("#title").fill("服务器保存但响应丢失");
  await other.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(other.locator(".notice-error").first()).toContainText(
    "网络连接失败",
  );
  await expect(other.locator("#title")).toHaveValue("服务器保存但响应丢失");
  await expect(
    other.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  const persisted = await other.request.get(`/api/travel-drafts/${draft.id}`);
  expect((await persisted.json()).data.title).toBe("服务器保存但响应丢失");
  await other.close();
});

test("草稿搜索分页、网络重试、离开提示与删除确认", async ({ page }) => {
  await signIn(page, "roster_03");
  for (let i = 0; i < 12; i++) await create(page, `分页行程 ${i}`);
  await page.goto("/travel/drafts");
  await expect(page.getByRole("row")).toHaveCount(11);
  await screenshot(page, "list-desktop");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByLabel("搜索", { exact: true }).fill("无结果词");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("没有符合条件的草稿")).toBeVisible();
  await page.getByLabel("搜索", { exact: true }).fill("分页行程 0");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.route("**/api/travel-drafts?*", (route) => route.abort());
  await page.getByRole("button", { name: "刷新列表" }).click();
  await expect(page.locator(".notice-error")).toContainText("网络连接失败");
  await page.unroute("**/api/travel-drafts?*");
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.getByRole("link", { name: "继续填写" }).click();
  await expect(page.locator("#title")).toHaveValue("分页行程 0");
  await page.locator("#remarks").fill("尚未保存");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "← 返回草稿列表" }).click();
  await expect(page.locator("#remarks")).toHaveValue("尚未保存");
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "删除草稿", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page).toHaveURL(/\/travel\/drafts$/);
  await expect(page.getByText(/共 11 条/)).toBeVisible();
});

test("手机差旅表单、附件、草稿列表和提交详情无溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "roster_04");
  await page.goto("/travel/new");
  await fillComplete(page);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。", { exact: true })).toBeVisible();
  await page.getByLabel("选择补充附件").setInputFiles({
    name: "手机行程.png",
    mimeType: "image/png",
    buffer: await png(),
  });
  await expect(
    page.getByRole("button", { name: "预览 手机行程.png", exact: true }),
  ).toBeVisible();
  await screenshot(page, "editor-mobile");
  await page
    .getByRole("button", { name: "预览 手机行程.png", exact: true })
    .click();
  await expect(page.getByRole("img")).toBeVisible();
  await screenshot(page, "preview-mobile");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "← 返回草稿列表" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await screenshot(page, "list-mobile");
  await page.getByRole("link", { name: "继续填写" }).click();
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(page.getByRole("heading", { name: "历史记录" })).toBeVisible();
  await screenshot(page, "detail-mobile");
});

test("页面认证、本人资源隔离、附件读取失败及无审批人反馈", async ({
  page,
  browser,
}) => {
  await page.goto("/travel/new");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "roster_05");
  const draft = await create(page, "受保护行程");
  const other = await browser.newContext();
  const outsider = await other.newPage();
  try {
    await signIn(outsider, "admin");
    await outsider.goto(`/travel/drafts/${draft.id}`);
    await expect(outsider.locator(".notice-error")).toBeVisible();
    await expect(outsider.locator("#title")).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.goto(`/travel/drafts/${draft.id}`);
  await expect(page.locator("#title")).toHaveValue("受保护行程");
  await page.getByLabel("选择补充附件").setInputFiles({
    name: "伪装.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator(".notice-error")).toContainText("仅支持真实");
  await page.getByLabel("选择补充附件").setInputFiles({
    name: "行程.png",
    mimeType: "image/png",
    buffer: await png(),
  });
  await expect(
    page.getByRole("button", { name: "预览 行程.png", exact: true }),
  ).toBeVisible();
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
    .getByRole("button", { name: "预览 行程.png", exact: true })
    .click();
  await expect(page.locator(".notice-error")).toContainText("附件缺失");
  await page.unroute("**/attachments/*/content");
  await page.route(`**/travel-drafts/${draft.id}/submit`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "APPROVER_UNRESOLVED",
          message: "本部门负责人必须恰有一名有效人员，请联系管理员核验授权",
        },
      }),
    }),
  );
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(page.locator(".notice-error").first()).toContainText("核验授权");
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeEnabled();
});
