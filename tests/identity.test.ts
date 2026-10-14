import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  accessHandler,
  auditHandler,
  departmentsHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  registerHandler,
  rolesHandler,
  usersHandler,
} from "../src/server/identity-handlers";

const origin = "http://localhost:3000";
const password = "Test-user-password";
let departmentId: string;
let adminId: string;
let adminToken: string;

function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function registration(username = "alice") {
  return {
    username,
    fullName: "测试用户",
    email: `${username}@example.invalid`,
    password,
    requestedDepartmentId: departmentId,
  };
}
async function registerUser(username = "alice") {
  const result = await registerHandler(
    request("auth/register", "POST", registration(username)),
  );
  expect(result.status).toBe(201);
  return (await result.json()).data;
}
async function signIn(username: string, client = "mobile") {
  return loginHandler(
    request("auth/login", "POST", { username, password, client }),
  );
}
function change(
  id: string,
  token = adminToken,
  extra: Record<string, unknown> = {},
) {
  return accessHandler(
    request(
      `admin/users/${id}/access`,
      "PATCH",
      {
        departmentId,
        status: "active",
        roles: ["employee"],
        reason: "核验组织身份",
        ...extra,
      },
      token,
    ),
    { params: Promise.resolve({ id }) },
  );
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = origin;
  process.env.SESSION_COOKIE_SECURE = "false";
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await seedOrganization(password);
  const login = await signIn("admin");
  expect(login.status).toBe(200);
  const result = (await login.json()).data;
  adminId = result.user.id;
  adminToken = result.token;
  departmentId = result.user.departmentId;
});
afterAll(closeDatabase);

test("注册仅赋普通员工及待确认状态；返回数据不含密码", async () => {
  const response = await registerHandler(
    request("auth/register", "POST", {
      ...registration(),
      username: " ALICE ",
      email: "Alice@EXAMPLE.invalid",
    }),
  );
  expect(response.status).toBe(201);
  const user = (await response.json()).data;
  expect(user).toMatchObject({
    username: "alice",
    email: "alice@example.invalid",
    status: "pending",
    roles: ["employee"],
    departmentId: null,
    requestedDepartmentId: departmentId,
  });
  expect(JSON.stringify(user)).not.toMatch(/password|scrypt/);
  expect((await departmentsHandler()).status).toBe(200);
});

test("注册拒绝角色/部门/状态注入、弱密码与不存在的部门", async () => {
  for (const extra of [
    { roles: ["system_admin"] },
    { departmentId },
    { status: "active" },
    { password: "short" },
    { requestedDepartmentId: "00000000-0000-4000-8000-000000000001" },
  ]) {
    expect(
      (
        await registerHandler(
          request("auth/register", "POST", { ...registration(), ...extra }),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (await database().query("SELECT count(*)::int AS total FROM users")).rows[0]
      .total,
  ).toBe(1);
});

test("并发重复注册只成功一次；邮箱不区分大小写", async () => {
  const responses = await Promise.all([
    registerHandler(request("auth/register", "POST", registration())),
    registerHandler(request("auth/register", "POST", registration())),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  const duplicateEmail = await registerHandler(
    request("auth/register", "POST", {
      ...registration("bob"),
      email: "ALICE@example.invalid",
    }),
  );
  expect(duplicateEmail.status).toBe(409);
});

test("Web 会话使用 HttpOnly Cookie；数据库仅保存令牌摘要", async () => {
  await registerUser();
  process.env.SESSION_COOKIE_SECURE = "true";
  const response = await signIn("alice", "web");
  process.env.SESSION_COOKIE_SECURE = "false";
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toMatch(/HttpOnly; SameSite=Lax; Max-Age=28800; Secure/);
  expect((await response.json()).data.token).toBeUndefined();
  const rawToken = cookie.split(";")[0].split("=")[1];
  expect(
    (
      await database().query(
        "SELECT token_hash FROM sessions WHERE token_hash=$1",
        [tokenHash(rawToken)],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await database().query(
        "SELECT token_hash FROM sessions WHERE token_hash=$1",
        [rawToken],
      )
    ).rowCount,
  ).toBe(0);
  const me = await meHandler(
    request("auth/me", "GET", undefined, undefined, {
      Cookie: cookie.split(";")[0],
    }),
  );
  expect((await me.json()).data.status).toBe("pending");
});

test("未登录及待确认用户不能进入管理接口；普通员工也不能授权", async () => {
  expect((await usersHandler(request("admin/users"))).status).toBe(401);
  const user = await registerUser();
  let token = (await (await signIn("alice")).json()).data.token;
  expect(
    (await usersHandler(request("admin/users", "GET", undefined, token)))
      .status,
  ).toBe(403);
  expect((await change(user.id)).status).toBe(200);
  token = (await (await signIn("alice")).json()).data.token;
  expect((await change(adminId, token)).status).toBe(403);
  expect(
    (await auditHandler(request("admin/audit-logs", "GET", undefined, token)))
      .status,
  ).toBe(403);
});

test("管理员确认与多角色授权写入审计并撤销旧会话", async () => {
  const user = await registerUser();
  const oldToken = (await (await signIn("alice")).json()).data.token;
  const result = await change(user.id, adminToken, {
    roles: ["employee", "department_head"],
  });
  expect(result.status).toBe(200);
  expect((await result.json()).data).toMatchObject({
    status: "active",
    departmentId,
    roles: ["department_head", "employee"],
  });
  expect(
    (await meHandler(request("auth/me", "GET", undefined, oldToken))).status,
  ).toBe(401);
  const audit = (
    await (
      await auditHandler(
        request("admin/audit-logs", "GET", undefined, adminToken),
      )
    ).json()
  ).data;
  expect(audit.total).toBe(2);
  expect(audit.items[0]).toMatchObject({
    actorId: adminId,
    targetId: user.id,
    before: { status: "pending" },
    after: { status: "active" },
    reason: "核验组织身份",
  });
  expect(JSON.stringify(audit)).not.toMatch(/password|scrypt|token_hash/);
});

test("禁用后新旧会话都不能使用；重新启用后可重新登录", async () => {
  const user = await registerUser();
  await change(user.id);
  const token = (await (await signIn("alice")).json()).data.token;
  expect(
    (await change(user.id, adminToken, { status: "disabled" })).status,
  ).toBe(200);
  expect(
    (await meHandler(request("auth/me", "GET", undefined, token))).status,
  ).toBe(401);
  expect((await signIn("alice")).status).toBe(401);
  await change(user.id);
  expect((await signIn("alice")).status).toBe(200);
});

test("退出幂等且仅撤销本次会话；过期会话被拒绝", async () => {
  await registerUser();
  const first = (await (await signIn("alice")).json()).data.token;
  const second = (await (await signIn("alice")).json()).data.token;
  for (let i = 0; i < 2; i++)
    expect(
      (await logoutHandler(request("auth/logout", "POST", undefined, first)))
        .status,
    ).toBe(200);
  expect(
    (await meHandler(request("auth/me", "GET", undefined, first))).status,
  ).toBe(401);
  expect(
    (await meHandler(request("auth/me", "GET", undefined, second))).status,
  ).toBe(200);
  await database().query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [tokenHash(second)],
  );
  expect(
    (await meHandler(request("auth/me", "GET", undefined, second))).status,
  ).toBe(401);
});

test("写操作拒绝跨站来源及无 Origin 的 Cookie；同源 Cookie 可操作", async () => {
  const user = await registerUser();
  const body = {
    departmentId,
    status: "active",
    roles: ["employee"],
    reason: "测试同源写入",
  };
  for (const originValue of [undefined, "https://evil.example"]) {
    const headers = {
      Cookie: `approval_session=${adminToken}`,
      ...(originValue ? { Origin: originValue } : {}),
    };
    expect(
      (
        await accessHandler(
          request("admin/users/access", "PATCH", body, undefined, headers),
          { params: Promise.resolve({ id: user.id }) },
        )
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await accessHandler(
        request("admin/users/access", "PATCH", body, undefined, {
          Cookie: `approval_session=${adminToken}`,
          Origin: origin,
        }),
        { params: Promise.resolve({ id: user.id }) },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await loginHandler(
        request(
          "auth/login",
          "POST",
          { username: "admin", password },
          undefined,
          { Origin: "https://evil.example" },
        ),
      )
    ).status,
  ).toBe(403);
});

test("拒绝自改权限、无理由、未知角色和越界分页", async () => {
  const user = await registerUser();
  expect((await change(adminId)).status).toBe(409);
  expect((await change(user.id, adminToken, { reason: " " })).status).toBe(400);
  expect(
    (await change(user.id, adminToken, { roles: ["employee", "superuser"] }))
      .status,
  ).toBe(400);
  expect(
    (
      await usersHandler(
        request("admin/users?pageSize=101", "GET", undefined, adminToken),
      )
    ).status,
  ).toBe(400);
  const list = await usersHandler(
    request(
      "admin/users?status=pending&pageSize=1",
      "GET",
      undefined,
      adminToken,
    ),
  );
  expect((await list.json()).data).toMatchObject({
    total: 1,
    page: 1,
    pageSize: 1,
    items: [{ id: user.id }],
  });
  const roles = await rolesHandler(
    request("admin/roles", "GET", undefined, adminToken),
  );
  expect((await roles.json()).data).toHaveLength(5);
});

test("审计写入失败会回滚权限变更及会话撤销", async () => {
  const user = await registerUser();
  const token = (await (await signIn("alice")).json()).data.token;
  // Force a real database write failure, then remove the test-only constraint.
  await database().query(
    "ALTER TABLE admin_audit_logs ADD CONSTRAINT test_reject_access CHECK (operation <> 'user.access_changed')",
  );
  try {
    expect((await change(user.id)).status).toBe(500);
    const me = (
      await (
        await meHandler(request("auth/me", "GET", undefined, token))
      ).json()
    ).data;
    expect(me.status).toBe("pending");
    expect(me.departmentId).toBeNull();
  } finally {
    await database().query(
      "ALTER TABLE admin_audit_logs DROP CONSTRAINT test_reject_access",
    );
  }
});

test("并发互相撤销管理员时仅一个成功，始终保留一名管理员", async () => {
  const user = await registerUser();
  await change(user.id, adminToken, { roles: ["employee", "system_admin"] });
  const secondAdmin = (await (await signIn("alice")).json()).data.token;
  const results = await Promise.all([
    change(user.id),
    change(adminId, secondAdmin),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  expect(
    (
      await database().query(
        "SELECT count(*)::int AS total FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='system_admin' AND u.registration_status='active'",
      )
    ).rows[0].total,
  ).toBe(1);
});

test("登录限流在数据库持久化，窗口到期可再次尝试", async () => {
  await registerUser();
  for (let i = 0; i < 10; i++) {
    expect(
      (
        await loginHandler(
          request("auth/login", "POST", {
            username: "alice",
            password: "wrong",
          }),
        )
      ).status,
    ).toBe(401);
  }
  expect((await signIn("alice")).status).toBe(429);
  await database().query(
    "UPDATE auth_rate_limits SET window_start=now()-interval '16 minutes' WHERE bucket=$1",
    [tokenHash("login:alice")],
  );
  expect((await signIn("alice")).status).toBe(200);
});

test("请求正文限制、损坏 JSON 和内容类型有明确错误", async () => {
  expect(
    (
      await registerHandler(
        request("auth/register", "POST", { padding: "x".repeat(17000) }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await registerHandler(
        new Request(`${origin}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await registerHandler(
        request("auth/register", "POST", registration(), undefined, {
          "Content-Type": "text/plain",
        }),
      )
    ).status,
  ).toBe(415);
});
