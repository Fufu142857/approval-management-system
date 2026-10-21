import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { businessActor } from "./business-actor";
import type { PurchaseDetail } from "../../src/lib/purchase-display";
const headers = { Origin: "http://127.0.0.1:3101" };
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function login(page: Page, username = "roster_02") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await button(page, "登录").click();
  await expect(page).toHaveURL(/\/account$/);
}
const fields = {
  title: "采购复制重提页面",
  reason: "设备更新",
  expectedDate: "2028-03-01",
  project: "研发项目",
  budgetLimit: "123.45",
  selectionReason: "交货及时",
  remarks: "原备注",
  items: [
    {
      name: "设备甲",
      specification: "型号 A",
      quantity: "1.5",
      unit: "件",
      unitPrice: "0.33",
    },
    {
      name: "设备乙",
      specification: "型号 B",
      quantity: "3",
      unit: "件",
      unitPrice: "0.10",
    },
  ],
  quotes: [
    {
      supplierName: "甲",
      quoteDate: "2028-02-01",
      amount: "0.80",
      basis: "书面询价",
      selected: true,
    },
    {
      supplierName: "乙",
      quoteDate: "2028-02-02",
      amount: "0.70",
      basis: "电话记录",
    },
  ],
};
async function submitted(page: Page, file = false) {
  const response = await page.request.post("/api/purchase-drafts", {
    headers,
    data: {
      ...fields,
      quotes: fields.quotes.map((quote, i) => ({
        ...quote,
        isOnline: file && i === 0,
        purchaseUrl: file && i === 0 ? "https://example.invalid/item" : "",
      })),
    },
  });
  expect(response.status()).toBe(201);
  const draft = (await response.json()).data;
  let version = draft.version;
  if (file) {
    const buffer = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const upload = await page.request.post(
      `/api/purchase-drafts/${draft.id}/quotes/${draft.quotes[0].id}/attachments`,
      {
        headers,
        multipart: {
          version: String(version),
          file: { name: "原附件.png", mimeType: "image/png", buffer },
        },
      },
    );
    expect(upload.status()).toBe(201);
    version = (await upload.json()).data.version;
  }
  const result = await page.request.post(
    `/api/purchase-drafts/${draft.id}/submit`,
    { headers, data: { version } },
  );
  expect(result.status()).toBe(200);
  return (await result.json()).data as PurchaseDetail;
}
async function withdraw(page: Page, value: PurchaseDetail) {
  const response = await page.request.post(
    `/api/purchase-applications/${value.application.id}/withdraw`,
    { headers, data: { version: value.application.version } },
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data as PurchaseDetail;
}
async function relation(page: Page, id: string) {
  const response = await page.request.get(
    `/api/purchase-applications/${id}/resubmission`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function shot(page: Page, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `tmp/screenshots/purchase-resubmission-${name}.png`,
    fullPage: true,
  });
}

test("撤回后确认复制、字段与附件提示、编辑提交及原申请双向关联", async ({
  page,
}) => {
  await login(page);
  const original = await withdraw(page, await submitted(page, true));
  const id = original.application.id;
  await page.goto(`/purchase/applications/${id}`);
  await button(page, "复制为新草稿").click();
  await expect(page.getByRole("dialog")).toContainText(
    "不复制附件、审批人或审批记录",
  );
  await shot(page, "confirm-desktop");
  await button(page, "取消").click();
  expect((await relation(page, id)).successor).toBeNull();
  await button(page, "复制为新草稿").click();
  await button(page, "确认复制").click();
  await expect(
    page.getByText("已创建关联原申请的新草稿，请编辑并确认后提交。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "编辑重提草稿" }).click();
  const next = (await relation(page, id)).successor;
  await expect(page).toHaveURL(new RegExp(`/purchase/drafts/${next.id}$`));
  await expect(page.locator("#budgetLimit")).toHaveValue("123.45");
  await expect(page.getByText(/这是关联原申请的重提草稿/)).toBeVisible();
  await expect(page.locator("#items-0-quantity")).toHaveValue("1.500");
  const copied = (
    await (await page.request.get(`/api/purchase-drafts/${next.id}`)).json()
  ).data;
  expect(copied.totalAmount).toBe("0.80");
  expect(copied.items[0].id).not.toBe(original.application.items[0].id);
  expect(copied.quotes[0].id).not.toBe(original.application.quotes[0].id);
  expect(
    (
      await (
        await page.request.get(`/api/purchase-drafts/${next.id}/attachments`)
      ).json()
    ).data.items,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "draft-mobile");
  await page.locator("#title").fill("修改后重新提交");
  await button(page, "提交申请").click();
  await expect(
    page.getByText(/线上报价须上传该报价的 JPEG\/PNG 截图/).first(),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const buffer = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel("选择报价附件", { exact: true })
    .setInputFiles({ name: "新报价.png", mimeType: "image/png", buffer });
  await expect(page.getByText("新报价.png", { exact: true })).toBeVisible();
  await button(page, "提交申请").click();
  await button(page, "确认提交").click();
  await expect(page).toHaveURL(
    new RegExp(`/purchase/applications/${next.id}$`),
  );
  await expect(
    page.getByText("本申请由原申请复制重提。", { exact: false }),
  ).toBeVisible();
  await shot(page, "submitted-mobile");
  await page.getByRole("link", { name: "查看原申请", exact: true }).click();
  await expect(page.getByRole("link", { name: "查看后续申请" })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/purchase-applications/${id}`)).json())
      .data,
  ).toEqual(original);
  expect(
    (
      await (
        await page.request.get(`/api/purchase-applications/${id}/attachments`)
      ).json()
    ).data.items,
  ).toHaveLength(1);
});

test("驳回后的两个窗口复制只产生同一个后续草稿，审批人没有复制入口", async ({
  page,
  browser,
}) => {
  await login(page, "roster_03");
  const value = await submitted(page);
  const headActor = await businessActor(browser, "roster_20");
  const head = headActor.page;
  const other = await page.context().newPage();
  try {
    const response = await head.request.post(
      `/api/purchase-applications/${value.application.id}/tasks/${value.tasks[0].id}/decision`,
      {
        headers,
        data: {
          version: value.application.version,
          decision: "reject",
          opinion: "补充行程",
        },
      },
    );
    expect(response.status()).toBe(200);
    await head.goto(`/purchase/applications/${value.application.id}`);
    await expect(head.getByText("补充行程", { exact: true })).toBeVisible();
    await expect(button(head, "复制为新草稿")).toHaveCount(0);
    await page.goto(`/purchase/applications/${value.application.id}`);
    await other.goto(page.url());
    await button(page, "复制为新草稿").click();
    await button(other, "复制为新草稿").click();
    await Promise.all([
      button(page, "确认复制").click(),
      button(other, "确认复制").click(),
    ]);
    const first = page.getByRole("link", { name: "编辑重提草稿" });
    const second = other.getByRole("link", { name: "编辑重提草稿" });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    expect(await first.getAttribute("href")).toBe(
      await second.getAttribute("href"),
    );
    await shot(page, "success-desktop");
    await page.reload();
    await expect(first).toBeVisible();
    await expect(button(page, "复制为新草稿")).toHaveCount(0);
  } finally {
    await other.close();
    await headActor.close();
  }
});

test("复制写入响应丢失暂停重试、GET 核对找回草稿、删除后可重建", async ({
  page,
}) => {
  await login(page);
  const value = await withdraw(page, await submitted(page));
  const id = value.application.id;
  await page.goto(`/purchase/applications/${id}`);
  let writes = 0;
  await page.route(
    `**/api/purchase-applications/${id}/resubmission`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      writes++;
      await route.fetch();
      await route.abort();
    },
  );
  await button(page, "复制为新草稿").click();
  await button(page, "确认复制").click();
  await expect(button(page, "复制为新草稿")).toBeDisabled();
  await expect(page.getByText(/复制结果需要核对/)).toBeVisible();
  await shot(page, "uncertain-desktop");
  expect(writes).toBe(1);
  await button(page, "核对复制结果").click();
  await expect(page.getByRole("link", { name: "编辑重提草稿" })).toBeVisible();
  expect(writes).toBe(1);
  const child = (await relation(page, id)).successor;
  const deleted = await page.request.delete(
    `/api/purchase-drafts/${child.id}`,
    {
      headers,
      data: { version: child.version },
    },
  );
  expect(deleted.status()).toBe(200);
  await button(page, "核对复制结果").click();
  await expect(button(page, "复制为新草稿")).toBeEnabled();
  await page.unroute(`**/api/purchase-applications/${id}/resubmission`);
  await button(page, "复制为新草稿").click();
  await button(page, "确认复制").click();
  await expect(page.getByRole("link", { name: "编辑重提草稿" })).toBeVisible();
  expect((await relation(page, id)).successor.id).not.toBe(child.id);
});

test("后续读取失败可恢复，复制版本冲突暂停写入并经详情刷新重新确认", async ({
  page,
}) => {
  await login(page, "roster_04");
  const original = await withdraw(page, await submitted(page));
  const id = original.application.id;
  const endpoint = `**/api/purchase-applications/${id}/resubmission`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "UNAVAILABLE", message: "后续查询暂不可用" },
      }),
    }),
  );
  await page.goto(`/purchase/applications/${id}`);
  await expect(
    page.getByText("后续查询暂不可用", { exact: true }),
  ).toBeVisible();
  await expect(button(page, "复制为新草稿")).toHaveCount(0);
  await page.unroute(endpoint);
  await button(page, "核对复制结果").click();
  await expect(button(page, "复制为新草稿")).toBeEnabled();
  let writes = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++;
    const response = await route.fetch({
      postData: JSON.stringify({ version: original.application.version - 1 }),
    });
    expect(response.status()).toBe(409);
    await route.fulfill({ response });
  });
  await button(page, "复制为新草稿").click();
  await button(page, "确认复制").click();
  await expect(page.getByText(/复制结果需要核对/)).toBeVisible();
  await expect(button(page, "复制为新草稿")).toBeDisabled();
  expect((await relation(page, id)).successor).toBeNull();
  expect(writes).toBe(1);
  await page.unroute(endpoint);
  await button(page, "刷新详情").click();
  await button(page, "复制为新草稿").click();
  await button(page, "确认复制").click();
  await expect(page.getByRole("link", { name: "编辑重提草稿" })).toBeVisible();
});
