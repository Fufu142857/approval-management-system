import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { travelDraftSchema } from "../src/lib/travel";
import { createTravelDraft } from "../src/server/travel";
import {
  submitTravelDraft,
  getTravelApplication,
} from "../src/server/travel-submission";
import {
  decideTravelTask,
  withdrawTravelApplication,
} from "../src/server/travel-actions";
import {
  notificationsHandler,
  notificationHandler,
  unreadNotificationsHandler,
  readNotificationHandler,
} from "../src/server/notification-handlers";
import type { NotificationItem } from "../src/lib/notifications";

const origin = "http://localhost:3000";
const people: Record<string, { id: string; token: string }> = {};
let departmentId: string;
function request(
  token = people.head.token,
  method = "GET",
  body?: unknown,
  search = "",
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/notifications${search}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const list = (search = "", token = people.head.token) =>
  notificationsHandler(request(token, "GET", undefined, search));
const detail = (id: string, token = people.head.token) =>
  notificationHandler(request(token), context(id));
const read = (id: string, token = people.head.token) =>
  readNotificationHandler(request(token, "POST", {}), context(id));
const count = (token = people.head.token) =>
  unreadNotificationsHandler(request(token));
async function submitted() {
  const saved = await createTravelDraft(
    people.owner.token,
    travelDraftSchema.parse({
      title: "通知验收",
      departure: "杭州",
      destination: "上海",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      purpose: "客户交流",
      transportation: "高铁",
      budget: "100.00",
    }),
  );
  return submitTravelDraft(people.owner.token, saved.id, 1);
}
async function firstNotice() {
  return (await (await list()).json()).data.items[0] as NotificationItem;
}
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = origin;
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await seedOrganization("Notification-test-password");
  departmentId = (
    await database().query("SELECT id FROM departments WHERE name='研发部'")
  ).rows[0].id;
  const adminId = (
    await database().query("SELECT id FROM users WHERE username='admin'")
  ).rows[0].id;
  for (const name of ["admin", "owner", "head", "finance", "pending"]) {
    const id =
      name === "admin"
        ? adminId
        : (
            await database().query(
              `INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
       SELECT $1::text,$1::text,$1::text||'@example.invalid',password_hash,$2,
         CASE WHEN $1::text='pending' THEN NULL ELSE $2::uuid END,
         CASE WHEN $1::text='pending' THEN 'pending' ELSE 'active' END FROM users WHERE id=$3 RETURNING id`,
              [name, departmentId, adminId],
            )
          ).rows[0].id;
    if (name !== "admin")
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
        [id],
      );
    if (name === "head" || name === "finance")
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, name === "head" ? "department_head" : "finance_approver"],
      );
    const token = randomBytes(32).toString("hex");
    await database().query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
      [tokenHash(token), id],
    );
    people[name] = { id, token };
  }
});
afterAll(closeDatabase);

test("本人列表/详情/未读数只返回本人事件，GET 不标记已读，空列表有正确总数", async () => {
  const app = await submitted();
  const response = await list();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = (await response.json()).data;
  expect(data).toMatchObject({
    total: 1,
    unreadCount: 1,
    page: 1,
    pageSize: 20,
  });
  const notice = data.items[0];
  expect(notice).toMatchObject({
    appId: app.application.id,
    kind: "approval.pending",
    readAt: null,
    target: {
      id: app.application.id,
      type: "travel",
      status: "pending",
      apiPath: `/api/travel-applications/${app.application.id}`,
    },
    task: { id: app.tasks[0].id, status: "pending" },
  });
  expect(notice.recipientId).toBeUndefined();
  expect(notice.eventKey).toBeUndefined();
  const single = await detail(notice.id);
  expect(single.status).toBe(200);
  expect((await single.json()).data).toMatchObject({
    id: notice.id,
    readAt: null,
  });
  expect((await (await count()).json()).data).toEqual({ unreadCount: 1 });
  for (const token of [
    people.owner.token,
    people.finance.token,
    people.admin.token,
  ]) {
    expect((await (await list("", token)).json()).data).toMatchObject({
      items: [],
      total: 0,
      unreadCount: 0,
    });
    expect((await (await count(token)).json()).data).toEqual({
      unreadCount: 0,
    });
  }
});

test("稳定分页、读状态筛选、越界页及全量未读数口径", async () => {
  const app = await submitted();
  await database().query(
    `INSERT INTO notifications(recipient_id,app_id,event_key,kind,title,created_at,read_at)
    SELECT $1,$2,'fixture:'||n,'application.approved','历史通知 '||n,'2026-01-01'::timestamptz,
      CASE WHEN n%2=0 THEN '2026-01-02'::timestamptz ELSE NULL END FROM generate_series(1,5) n`,
    [people.head.id, app.application.id],
  );
  const all = (await (await list()).json()).data;
  expect(all).toMatchObject({ total: 6, unreadCount: 4 });
  const ids = all.items.map((n: NotificationItem) => n.id);
  const collected: string[] = [];
  for (const page of [1, 2, 3]) {
    const data = (await (await list(`?page=${page}&pageSize=2`)).json()).data;
    expect(data.total).toBe(6);
    collected.push(...data.items.map((n: NotificationItem) => n.id));
  }
  expect(collected).toEqual(ids);
  expect(new Set(ids).size).toBe(6);
  expect((await (await list("?page=10&pageSize=2")).json()).data).toMatchObject(
    { items: [], total: 6, unreadCount: 4 },
  );
  expect((await (await list("?state=unread")).json()).data).toMatchObject({
    total: 4,
    unreadCount: 4,
  });
  const readOnly = (await (await list("?state=read")).json()).data;
  expect(readOnly).toMatchObject({ total: 2, unreadCount: 4 });
  expect(readOnly.items.every((n: NotificationItem) => n.readAt !== null)).toBe(
    true,
  );
});

test("重复及并发标记已读保留首次时间，不改变事件/任务/审批历史", async () => {
  const app = await submitted();
  const notice = await firstNotice();
  const results = await Promise.all([read(notice.id), read(notice.id)]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  const values = await Promise.all(
    results.map(async (r) => (await r.json()).data),
  );
  expect(values[0]).toEqual(values[1]);
  expect(values[0].readAt).toBeTruthy();
  expect((await (await read(notice.id)).json()).data).toEqual(values[0]);
  expect((await (await count()).json()).data.unreadCount).toBe(0);
  expect((await (await list("?state=unread")).json()).data.total).toBe(0);
  expect((await (await list("?state=read")).json()).data.total).toBe(1);
  expect(
    await getTravelApplication(people.owner.token, app.application.id),
  ).toEqual(app);
});

test("他人和管理员都不能查询或标记该通知，随机 ID 与无权 ID 均 404", async () => {
  await submitted();
  const notice = await firstNotice();
  for (const token of [
    people.admin.token,
    people.owner.token,
    people.finance.token,
  ]) {
    expect((await detail(notice.id, token)).status).toBe(404);
    expect((await read(notice.id, token)).status).toBe(404);
  }
  expect((await detail(randomUUID())).status).toBe(404);
  expect((await read(randomUUID())).status).toBe(404);
  expect((await (await detail(notice.id)).json()).data.readAt).toBeNull();
});

test("查询与正文白名单拒绝接收人伪造、非法筛选、分页和时间戳注入", async () => {
  await submitted();
  const notice = await firstNotice();
  for (const search of [
    "?page=0",
    "?page=100001",
    "?pageSize=101",
    "?pageSize=1.5",
    "?state=unknown",
    `?recipientId=${people.head.id}`,
  ])
    expect((await list(search)).status).toBe(400);
  expect(
    (
      await unreadNotificationsHandler(
        request(people.head.token, "GET", undefined, "?recipientId=x"),
      )
    ).status,
  ).toBe(400);
  expect((await detail("bad-id")).status).toBe(400);
  expect((await read("bad-id")).status).toBe(400);
  for (const body of [
    { readAt: "2026-01-01" },
    { recipientId: people.head.id },
    { read: false },
  ])
    expect(
      (
        await readNotificationHandler(
          request(people.head.token, "POST", body),
          context(notice.id),
        )
      ).status,
    ).toBe(400);
});

test("未确认、过期、停用和无效部门无法读取或标记通知", async () => {
  await submitted();
  const notice = await firstNotice();
  for (const [token, status] of [
    [people.pending.token, 403],
    ["0".repeat(64), 401],
  ] as const) {
    expect((await list("", token)).status).toBe(status);
    expect((await count(token)).status).toBe(status);
    expect((await detail(notice.id, token)).status).toBe(status);
    expect((await read(notice.id, token)).status).toBe(status);
  }
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    departmentId,
  ]);
  expect((await list()).status).toBe(403);
  expect((await read(notice.id)).status).toBe(403);
  await database().query("UPDATE departments SET active=true WHERE id=$1", [
    departmentId,
  ]);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.head.id],
  );
  expect((await count()).status).toBe(401);
  await database().query(
    "UPDATE users SET registration_status='active' WHERE id=$1",
    [people.head.id],
  );
  await database().query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [people.head.id],
  );
  expect((await detail(notice.id)).status).toBe(401);
  expect((await read(notice.id)).status).toBe(401);
});

test("Cookie 写请求需同源 Origin，错误媒体类型拒绝；读取支持 Cookie", async () => {
  await submitted();
  const notice = await firstNotice();
  const cookie = { Cookie: `approval_session=${people.head.token}` };
  expect(
    (
      await notificationHandler(
        request("", "GET", undefined, "", cookie),
        context(notice.id),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await readNotificationHandler(
        request("", "POST", {}, "", cookie),
        context(notice.id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await readNotificationHandler(
        request("", "POST", {}, "", {
          ...cookie,
          Origin: "https://example.invalid",
        }),
        context(notice.id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await readNotificationHandler(
        request(people.head.token, "POST", {}, "", {
          "Content-Type": "text/plain",
        }),
        context(notice.id),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await readNotificationHandler(
        request("", "POST", {}, "", { ...cookie, Origin: origin }),
        context(notice.id),
      )
    ).status,
  ).toBe(200);
});

test("撤回后的旧待办事件保留，但详情目标与任务状态变为 withdrawn/cancelled", async () => {
  const app = await submitted();
  const notice = await firstNotice();
  await withdrawTravelApplication(people.owner.token, app.application.id, {
    version: 2,
    opinion: "取消",
  });
  const result = (await (await detail(notice.id)).json()).data;
  expect(result).toMatchObject({
    kind: "approval.pending",
    title: notice.title,
    readAt: null,
    target: { status: "withdrawn" },
    task: { status: "cancelled" },
  });
  expect((await (await list()).json()).data).toMatchObject({
    total: 2,
    unreadCount: 2,
  });
  expect((await (await list("", people.finance.token)).json()).data.total).toBe(
    0,
  );
});

test("通过后通知返回当前申请状态，已办旧待办不会成为下一人的任务", async () => {
  const app = await submitted();
  const notice = await firstNotice();
  await decideTravelTask(
    people.head.token,
    app.application.id,
    app.tasks[0].id,
    { version: 2, decision: "approve", opinion: "" },
  );
  expect((await (await detail(notice.id)).json()).data).toMatchObject({
    task: { status: "approved", id: app.tasks[0].id },
    target: { status: "pending" },
  });
  const finance = (await (await list("", people.finance.token)).json()).data
    .items[0];
  expect(finance.task).toMatchObject({
    id: app.tasks[1].id,
    status: "pending",
  });
  await decideTravelTask(
    people.finance.token,
    app.application.id,
    app.tasks[1].id,
    { version: 3, decision: "approve", opinion: "" },
  );
  const owner = (await (await list("", people.owner.token)).json()).data
    .items[0];
  expect(owner).toMatchObject({
    kind: "application.approved",
    target: { status: "approved" },
    task: null,
  });
  expect((await (await detail(notice.id)).json()).data.target.status).toBe(
    "approved",
  );
});

test("拥有通知不等于正文授权，无正文权限时不泄露目标状态或任务", async () => {
  const app = await submitted();
  const id = (
    await database().query(
      "INSERT INTO notifications(recipient_id,app_id,event_key,kind,title) VALUES ($1,$2,'legacy:event','application.withdrawn','旧通知') RETURNING id",
      [people.finance.id, app.application.id],
    )
  ).rows[0].id;
  const result = (await (await detail(id, people.finance.token)).json()).data;
  expect(result).toMatchObject({ id, target: null, task: null });
  expect(
    (await (await list("", people.finance.token)).json()).data.items[0],
  ).toMatchObject({ target: null, task: null });
  await expect(
    getTravelApplication(people.finance.token, app.application.id),
  ).rejects.toMatchObject({ status: 404 });
  expect((await read(id, people.finance.token)).status).toBe(200);
});

test("已读写入失败回滚，重建连接与重复迁移仍保留事件和阅读时间", async () => {
  await submitted();
  const notice = await firstNotice();
  await database().query(
    "ALTER TABLE notifications ADD CONSTRAINT test_unread_only CHECK(read_at IS NULL)",
  );
  try {
    expect((await read(notice.id)).status).toBe(500);
    expect((await (await count()).json()).data.unreadCount).toBe(1);
  } finally {
    await database().query(
      "ALTER TABLE notifications DROP CONSTRAINT test_unread_only",
    );
  }
  const marked = (await (await read(notice.id)).json()).data;
  await closeDatabase();
  await migrate();
  expect((await (await detail(notice.id)).json()).data.readAt).toBe(
    marked.readAt,
  );
  expect((await (await count()).json()).data.unreadCount).toBe(0);
});

test("等待组织锁后重新鉴权，撤销会话不能继续标记已读", async () => {
  await submitted();
  const notice = await firstNotice();
  const gate = await database().connect();
  let pending: Promise<Response> | undefined;
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(72002)");
    pending = read(notice.id);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = (
        await gate.query(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=72002 AND NOT granted) AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await gate.query("DELETE FROM sessions WHERE user_id=$1", [people.head.id]);
    await gate.query("COMMIT");
    expect((await pending).status).toBe(401);
    expect(
      (
        await database().query(
          "SELECT read_at FROM notifications WHERE id=$1",
          [notice.id],
        )
      ).rows[0].read_at,
    ).toBeNull();
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await pending;
  }
});
