import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import type { TravelDetail } from "../../src/lib/travel-display";
const headers = { Origin: "http://127.0.0.1:3101" };
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function login(page: Page, username = "roster_18") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-password");
  await button(page, "登录").click();
  await expect(page).toHaveURL(/\/account$/);
}
const fields = {
  title: "复制重提页面",
  departure: "杭州",
  destination: "上海",
  startDate: "2028-02-28",
  endDate: "2028-03-01",
  purpose: "修改行程",
  companions: "同行人",
  transportation: "高铁",
  budget: "123.45",
  remarks: "原备注",
};
async function submitted(page: Page, file = false) {
  const response = await page.request.post("/api/travel-drafts", {
    headers,
    data: fields,
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
      `/api/travel-applications/${draft.id}/attachments`,
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
    `/api/travel-drafts/${draft.id}/submit`,
    { headers, data: { version } },
  );
  expect(result.status()).toBe(200);
  return (await result.json()).data as TravelDetail;
}
async function withdraw(page: Page, value: TravelDetail) {
  const response = await page.request.post(
    `/api/travel-applications/${value.application.id}/withdraw`,
    { headers, data: { version: value.application.version } },
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data as TravelDetail;
}
async function relation(page: Page, id: string) {
  const response = await page.request.get(
    `/api/travel-applications/${id}/resubmission`,
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
    path: `tmp/screenshots/resubmission-${name}.png`,
    fullPage: true,
  });
}

test("撤回后确认复制、字段与附件提示、编辑提交及原申请双向关联", async ({
  page,
}) => {
  await login(page);
  const original = await withdraw(page, await submitted(page, true));
  const id = original.application.id;
  await page.goto(`/travel/applications/${id}`);
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
  await expect(page).toHaveURL(new RegExp(`/travel/drafts/${next.id}$`));
  await expect(page.locator("#budget")).toHaveValue("123.45");
  await expect(page.getByText(/这是关联原申请的重提草稿/)).toBeVisible();
  expect(
    (
      await (
        await page.request.get(
          `/api/travel-applications/${next.id}/attachments`,
        )
      ).json()
    ).data.items,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "draft-mobile");
  await page.locator("#title").fill("修改后重新提交");
  await button(page, "提交申请").click();
  await button(page, "确认提交").click();
  await expect(page).toHaveURL(new RegExp(`/travel/applications/${next.id}$`));
  await expect(
    page.getByText("本申请由原申请复制重提。", { exact: false }),
  ).toBeVisible();
  await shot(page, "submitted-mobile");
  await page.getByRole("link", { name: "查看原申请", exact: true }).click();
  await expect(page.getByRole("link", { name: "查看后续申请" })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/travel-applications/${id}`)).json())
      .data,
  ).toEqual(original);
  expect(
    (
      await (
        await page.request.get(`/api/travel-applications/${id}/attachments`)
      ).json()
    ).data.items,
  ).toHaveLength(1);
});

test("驳回后的两个窗口复制只产生同一个后续草稿，审批人没有复制入口", async ({
  page,
  browser,
}) => {
  await login(page, "roster_19");
  const value = await submitted(page);
  const headContext = await browser.newContext();
  const head = await headContext.newPage();
  const other = await page.context().newPage();
  try {
    await login(head, "roster_20");
    const response = await head.request.post(
      `/api/travel-applications/${value.application.id}/tasks/${value.tasks[0].id}/decision`,
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
    await head.goto(`/travel/applications/${value.application.id}`);
    await expect(head.getByText("补充行程", { exact: true })).toBeVisible();
    await expect(button(head, "复制为新草稿")).toHaveCount(0);
    await page.goto(`/travel/applications/${value.application.id}`);
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
    await headContext.close();
  }
});

test("复制写入响应丢失暂停重试、GET 核对找回草稿、删除后可重建", async ({
  page,
}) => {
  await login(page);
  const value = await withdraw(page, await submitted(page));
  const id = value.application.id;
  await page.goto(`/travel/applications/${id}`);
  let writes = 0;
  await page.route(
    `**/api/travel-applications/${id}/resubmission`,
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
  const deleted = await page.request.delete(`/api/travel-drafts/${child.id}`, {
    headers,
    data: { version: child.version },
  });
  expect(deleted.status()).toBe(200);
  await button(page, "核对复制结果").click();
  await expect(button(page, "复制为新草稿")).toBeEnabled();
  await page.unroute(`**/api/travel-applications/${id}/resubmission`);
  await button(page, "复制为新草稿").click();
  await button(page, "确认复制").click();
  await expect(page.getByRole("link", { name: "编辑重提草稿" })).toBeVisible();
  expect((await relation(page, id)).successor.id).not.toBe(child.id);
});
