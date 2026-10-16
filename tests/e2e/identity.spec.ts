import { test, expect, type Page } from "@playwright/test";
const password = "Browser-test-password";

test("未启用 JavaScript 时密码不会被表单放进 URL", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await expect(
      page.getByText("请启用 JavaScript 后使用账号功能。", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("用户名", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(password);
    const submitted = page.waitForRequest(
      (request) => request.isNavigationRequest() && request.method() === "POST",
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const request = await submitted;
    expect(new URL(request.url()).search).toBe("");
    expect(request.postData()).toContain("password=");
  } finally {
    await context.close();
  }
});
async function signIn(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("注册、待确认、管理员授权、重新登录、审计和停用闭环", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "登录审批管理系统" }),
  ).toBeVisible();
  await page.screenshot({
    path: "tmp/screenshots/identity-login.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "注册账号" }).click();
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByLabel("用户名", { exact: true })).toBeFocused();
  await expect(
    page.getByText("请选择申请加入的部门。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("用户名", { exact: true }).fill("browser_member");
  await page.getByLabel("姓名", { exact: true }).fill("浏览器验收成员");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("browser_member@example.invalid");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page
    .getByLabel("申请部门", { exact: true })
    .selectOption({ label: "研发部" });
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("heading", { name: "账号已创建" })).toBeVisible();
  await signIn(page, "browser_member");
  await expect(page.getByText("等待管理员确认", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "管理后台", exact: true }),
  ).toHaveCount(0);
  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "approval_session",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "approval_session",
  );
  await page.screenshot({
    path: "tmp/screenshots/identity-pending.png",
    fullPage: true,
  });
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  try {
    await signIn(admin, "admin");
    await admin.getByRole("link", { name: "管理后台", exact: true }).click();
    await admin.getByLabel("状态筛选", { exact: true }).selectOption("pending");
    await admin
      .getByRole("button", { name: "管理 browser_member", exact: true })
      .click();
    await admin.getByRole("button", { name: "检查变更" }).click();
    await expect(
      admin.getByRole("alert").filter({ hasText: "变更原因" }),
    ).toBeVisible();
    await admin
      .getByLabel("确认部门", { exact: true })
      .selectOption({ label: "市场部" });
    await admin
      .getByRole("checkbox", { name: "部门负责人", exact: true })
      .check();
    await admin
      .getByLabel("变更原因", { exact: true })
      .fill("核验部门归属，授予部门负责人权限");
    await admin.getByRole("button", { name: "检查变更" }).click();
    await admin.getByRole("button", { name: "返回修改" }).click();
    await expect(admin.getByLabel("变更原因", { exact: true })).toHaveValue(
      "核验部门归属，授予部门负责人权限",
    );
    await expect(
      admin.getByRole("checkbox", { name: "部门负责人", exact: true }),
    ).toBeChecked();
    await admin.getByRole("button", { name: "检查变更" }).click();
    await admin.screenshot({
      path: "tmp/screenshots/identity-access-review.png",
      fullPage: true,
    });
    await admin.getByRole("button", { name: "确认保存" }).click();
    await expect(
      admin.getByText("权限已保存并记录审计，该用户需要重新登录。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      admin.getByText("没有符合条件的用户", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重新查看账号状态" }).click();
    await expect(page).toHaveURL(/\/login\?expired=1/);
    await signIn(page, "browser_member");
    await expect(page.getByText("已启用", { exact: true })).toBeVisible();
    await expect(page.getByText("部门负责人", { exact: true })).toBeVisible();
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/account\?denied=1/);
    await expect(
      page.getByRole("alert").filter({ hasText: "没有管理权限" }),
    ).toBeVisible();
    await admin.getByRole("link", { name: "操作审计", exact: true }).click();
    await expect(
      admin.getByText("核验部门归属，授予部门负责人权限", { exact: true }),
    ).toBeVisible();
    await admin.getByText("查看变更详情", { exact: true }).first().click();
    await expect(
      admin.getByText("操作者 ID", { exact: true }).first(),
    ).toBeVisible();
    await admin.screenshot({
      path: "tmp/screenshots/identity-audit.png",
      fullPage: true,
    });
    await admin.getByRole("link", { name: "管理后台", exact: true }).click();
    await admin
      .getByRole("button", { name: "管理 browser_member", exact: true })
      .click();
    await admin
      .getByLabel("账号状态", { exact: true })
      .last()
      .selectOption("disabled");
    await admin.getByLabel("变更原因", { exact: true }).fill("停用验收账号");
    await admin.getByRole("button", { name: "检查变更" }).click();
    await expect(admin.getByText(/保存后该用户将无法登录/)).toBeVisible();
    await admin.getByRole("button", { name: "确认保存" }).click();
    await expect(
      admin.getByText("权限已保存并记录审计，该用户需要重新登录。", {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("用户名", { exact: true }).fill("browser_member");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "账户不可用" }),
    ).toBeVisible();
  } finally {
    await adminContext.close();
  }
  expect(errors).toEqual([]);
});

test("管理分页、网络失败重试、取消不提交与退出保护", async ({ page }) => {
  await signIn(page, "admin");
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.screenshot({
    path: "tmp/screenshots/identity-users.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(
    page.getByRole("navigation", { name: "列表分页" }),
  ).toContainText("第 2");
  await page
    .getByRole("button", { name: /^管理 / })
    .first()
    .click();
  await page.getByLabel("变更原因", { exact: true }).fill("这次变更会被取消");
  await page.getByRole("button", { name: "检查变更" }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认保存" })).toHaveCount(0);
  await page.route("**/api/admin/users?*", (route) => route.abort());
  await page.getByRole("button", { name: "刷新列表" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "网络连接失败" }),
  ).toBeVisible();
  await page.unroute("**/api/admin/users?*");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(11);
  await page.getByRole("link", { name: "操作审计", exact: true }).click();
  await expect(page.getByText("这次变更会被取消", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("用户菜单", { exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin/audit");
  await expect(page).toHaveURL(/\/login/);
});

test("手机注册错误、重复账号、普通员工资料与退出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/register");
  await page.getByLabel("用户名", { exact: true }).fill("roster_00");
  await page.getByLabel("姓名", { exact: true }).fill("重复测试");
  await page.getByLabel("邮箱", { exact: true }).fill("invalid");
  await page.getByLabel("密码", { exact: true }).fill("short");
  await page
    .getByLabel("申请部门", { exact: true })
    .selectOption({ label: "研发部" });
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeFocused();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await noOverflow(page);
  await page.screenshot({
    path: "tmp/screenshots/identity-mobile-register.png",
    fullPage: true,
  });
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("duplicate@example.invalid");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "用户名或邮箱已存在" }),
  ).toBeVisible();
  await signIn(page, "roster_00");
  await expect(page.getByRole("heading", { name: "基本资料" })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: "tmp/screenshots/identity-mobile-account.png",
    fullPage: true,
  });
  await page.getByLabel("用户菜单", { exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("手机管理员列表、授权表单和审计无页面溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "admin");
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(11);
  await noOverflow(page);
  await page
    .getByRole("button", { name: /^管理 / })
    .first()
    .click();
  await expect(page.getByLabel("变更原因", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: "tmp/screenshots/identity-mobile-admin.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("link", { name: "操作审计", exact: true }).click();
  await expect(
    page.getByText("查看变更详情", { exact: true }).first(),
  ).toBeVisible();
  await page.getByText("查看变更详情", { exact: true }).first().click();
  await noOverflow(page);
});
