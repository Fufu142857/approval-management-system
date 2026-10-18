import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { travelDraftSchema } from "../src/lib/travel";
import type {
  TravelApplicationSummary,
  TravelList,
  TravelTaskSummary,
} from "../src/lib/travel-lists";
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
  travelApplicationsHandler,
  travelTasksHandler,
} from "../src/server/travel-list-handlers";

const origin = "http://localhost:3000";
const people: Record<string, { id: string; token: string }> = {};
let departmentId: string;
function request(path: string, token: string) {
  return new Request(`${origin}/api/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
const own = (search = "", token = people.owner.token) =>
  travelApplicationsHandler(request(`travel-applications${search}`, token));
const tasks = (search = "", token = people.head.token) =>
  travelTasksHandler(request(`travel-tasks${search}`, token));
async function ownData(search = "", token = people.owner.token) {
  const response = await own(search, token);
  expect(response.status).toBe(200);
  return (await response.json()).data as TravelList<TravelApplicationSummary>;
}
async function taskData(search = "", token = people.head.token) {
  const response = await tasks(search, token);
  expect(response.status).toBe(200);
  return (await response.json()).data as TravelList<TravelTaskSummary> & {
    state: string;
  };
}
async function draft(title = "差旅 List 验收", token = people.owner.token) {
  return createTravelDraft(
    token,
    travelDraftSchema.parse({
      title,
      departure: "杭州",
      destination: "上海",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      purpose: "不应出现在列表的正文",
      transportation: "高铁",
      budget: "100.00",
    }),
  );
}
async function submitted(title?: string) {
  const saved = await draft(title);
  return submitTravelDraft(people.owner.token, saved.id, 1);
}
type Detail = Awaited<ReturnType<typeof submitted>>;
function decide(
  app: Detail,
  index = 0,
  decision: "approve" | "reject" = "approve",
  token = people.head.token,
) {
  return decideTravelTask(token, app.application.id, app.tasks[index].id, {
    version: app.application.version,
    decision,
    opinion: decision === "reject" ? "需修改" : "同意",
  });
}
function withdraw(app: Detail) {
  return withdrawTravelApplication(people.owner.token, app.application.id, {
    version: app.application.version,
    opinion: "行程取消",
  });
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
  await seedOrganization("Travel-list-test-password");
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

test("本人全状态列表隔离所有权，摘要有快照/当前节点且不泄露完整正文", async () => {
  const saved = await draft();
  const pending = await submitted();
  await decide(
    await decide(await submitted()),
    1,
    "approve",
    people.finance.token,
  );
  await decide(await submitted(), 0, "reject");
  await withdraw(await submitted());
  const response = await own();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await ownData();
  expect(data).toMatchObject({ total: 5, page: 1, pageSize: 20 });
  expect(data.items.map((x) => x.status).sort()).toEqual([
    "approved",
    "draft",
    "pending",
    "rejected",
    "withdrawn",
  ]);
  expect(data.items.find((x) => x.id === saved.id)).toMatchObject({
    version: 1,
    submittedAt: null,
    currentTask: null,
  });
  expect(data.items.find((x) => x.id === pending.application.id)).toMatchObject(
    {
      currentTask: {
        id: pending.tasks[0].id,
        seqNo: 1,
        approver: { id: people.head.id, name: "head" },
      },
      applicant: {
        id: people.owner.id,
        name: "owner",
        departmentId,
        departmentName: "研发部",
      },
    },
  );
  expect(JSON.stringify(data)).not.toContain("不应出现在列表的正文");
  for (const status of [
    "draft",
    "pending",
    "approved",
    "rejected",
    "withdrawn",
  ]) {
    expect((await ownData(`?status=${status}`)).total).toBe(1);
    if (status !== "pending")
      expect(
        data.items.find((x) => x.status === status)?.currentTask,
      ).toBeNull();
  }
  for (const name of ["head", "finance", "admin"])
    expect((await ownData("", people[name].token)).total).toBe(0);
  await draft("管理员本人草稿", people.admin.token);
  expect((await ownData("", people.admin.token)).total).toBe(1);
  expect((await ownData()).total).toBe(5);
});

test("待办只含当前实际审批人，前一步通过后切换且管理权限不放行", async () => {
  const app = await submitted();
  const before = await taskData();
  expect(before).toMatchObject({ total: 1, state: "pending" });
  expect(before.items[0]).toMatchObject({
    id: app.tasks[0].id,
    status: "pending",
    finishedAt: null,
    application: { id: app.application.id, version: 2, status: "pending" },
  });
  for (const name of ["owner", "finance", "admin"])
    expect((await taskData("", people[name].token)).total).toBe(0);
  await decide(app);
  expect((await taskData()).total).toBe(0);
  const finance = await taskData("", people.finance.token);
  expect(finance.items[0]).toMatchObject({
    id: app.tasks[1].id,
    seqNo: 2,
    application: {
      version: 3,
      currentTask: { id: app.tasks[1].id, approver: { id: people.finance.id } },
    },
  });
  expect((await taskData("?status=approved", people.finance.token)).total).toBe(
    0,
  );
});

test("已办按本人的决策任务统计，申请当前终态与原审批结果分别保留", async () => {
  const first = await decide(await submitted());
  expect((await taskData("?state=handled")).items[0]).toMatchObject({
    status: "approved",
    application: { status: "pending" },
  });
  await withdraw(first);
  await decide(await submitted(), 0, "reject");
  const handled = await taskData("?state=handled");
  expect(handled.total).toBe(2);
  expect(handled.items.map((x) => x.status).sort()).toEqual([
    "approved",
    "rejected",
  ]);
  expect(
    (await taskData("?state=handled&status=withdrawn")).items[0],
  ).toMatchObject({
    status: "approved",
    application: { status: "withdrawn", currentTask: null },
  });
  expect((await taskData("?state=handled", people.owner.token)).total).toBe(0);
});

test("撤回的已激活和未激活任务均不冒充已办，历史正文权限仍按激活区分", async () => {
  const app = await submitted();
  await withdraw(app);
  for (const name of ["head", "finance"]) {
    expect((await taskData("", people[name].token)).total).toBe(0);
    expect((await taskData("?state=handled", people[name].token)).total).toBe(
      0,
    );
  }
  expect(
    (await getTravelApplication(people.head.token, app.application.id))
      .application.status,
  ).toBe("withdrawn");
  await expect(
    getTravelApplication(people.finance.token, app.application.id),
  ).rejects.toMatchObject({ status: 404 });
});

test("同一人员承担两节点时按任务分页，旧已办不替代下一待办", async () => {
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='finance_approver'",
    [people.finance.id],
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'finance_approver')",
    [people.head.id],
  );
  const first = await decide(await submitted());
  expect((await taskData()).items[0].seqNo).toBe(2);
  expect((await taskData("?state=handled")).items[0].seqNo).toBe(1);
  await decide(first, 1);
  const handled = await taskData("?state=handled&pageSize=1");
  expect(handled.total).toBe(2);
  expect(handled.items[0].seqNo).toBe(2);
  expect(
    (await taskData("?state=handled&pageSize=1&page=2")).items[0].seqNo,
  ).toBe(1);
  expect((await ownData()).total).toBe(1);
});

test("标题/编号关键词为字面量且忽略大小写，分页稳定并保留越界总数", async () => {
  const one = await draft("差旅 100%_ Literal");
  const two = await draft("差旅 List");
  await draft("第三个");
  await database().query(
    "UPDATE applications SET created_at='2026-10-01T00:00:00Z'",
  );
  expect((await ownData("?keyword=%25_")).items.map((x) => x.id)).toEqual([
    one.id,
  ]);
  expect(
    (await ownData(`?keyword=${two.appNo.toLowerCase()}`)).items[0].id,
  ).toBe(two.id);
  expect((await ownData("?keyword=%20lIsT%20")).total).toBe(1);
  expect((await ownData("?keyword='OR%201=1--")).total).toBe(0);
  const all = await ownData();
  const page1 = await ownData("?pageSize=2");
  const page2 = await ownData("?pageSize=2&page=2");
  expect([...page1.items, ...page2.items].map((x) => x.id)).toEqual(
    all.items.map((x) => x.id),
  );
  expect(all.items.map((x) => x.id)).toEqual(all.items.map((x) => x.id).sort());
  expect(await ownData("?page=9&pageSize=2")).toMatchObject({
    total: 3,
    items: [],
  });
  expect(await ownData("?keyword=不存在")).toMatchObject({
    total: 0,
    items: [],
  });
});

test("申请时间按创建日上海时区包含首尾，不受后续更新时间影响", async () => {
  for (const time of [
    "2028-02-28T15:59:59.999Z",
    "2028-02-28T16:00:00Z",
    "2028-02-29T15:59:59.999Z",
    "2028-02-29T16:00:00Z",
  ]) {
    const app = await draft();
    await database().query(
      "UPDATE applications SET created_at=$2 WHERE id=$1",
      [app.id, time],
    );
  }
  expect((await ownData("?from=2028-02-29&to=2028-02-29")).total).toBe(2);
  expect((await ownData("?from=2028-03-01")).total).toBe(1);
  expect((await ownData("?to=2028-02-28")).total).toBe(1);
  expect((await ownData("?from=0001-01-01&to=9999-12-31")).total).toBe(4);
});

test("任务时间筛选使用激活/完成时间，已办排序/关键词/空页总数正确", async () => {
  const app = await submitted("任务 Special%_");
  await database().query(
    "UPDATE approval_tasks SET activated_at='2028-02-28T16:00:00Z' WHERE id=$1",
    [app.tasks[0].id],
  );
  expect(
    (await taskData("?from=2028-02-29&to=2028-02-29&keyword=Special%25_"))
      .total,
  ).toBe(1);
  expect((await taskData("?to=2028-02-28")).total).toBe(0);
  await decide(app);
  await database().query(
    "UPDATE approval_tasks SET finished_at='2028-02-29T15:59:59.999Z' WHERE id=$1",
    [app.tasks[0].id],
  );
  expect(
    (await taskData("?state=handled&from=2028-02-29&to=2028-02-29")).total,
  ).toBe(1);
  expect((await taskData("?state=handled&from=2028-03-01")).total).toBe(0);
  expect(await taskData("?state=handled&page=9&pageSize=1")).toMatchObject({
    total: 1,
    items: [],
  });
  expect(
    (
      await taskData(
        `?state=handled&keyword=${app.application.appNo.toLowerCase()}`,
      )
    ).total,
  ).toBe(1);
});

test("拒绝越界分页、非法日期/范围、未知字段、身份注入和重复查询参数", async () => {
  const bad = [
    "page=0",
    "page=100001",
    "pageSize=101",
    "pageSize=",
    "page=1.5",
    "page=Infinity",
    "from=2027-02-29",
    "from=0000-01-01",
    "to=2026-11-01T00:00:00Z",
    "from=2026-12-01&to=2026-11-01",
    "status=cancelled",
    "type=purchase",
    "keyword=" + "a".repeat(201),
    "applicantId=" + randomUUID(),
    "departmentId=" + departmentId,
    "approverId=" + people.head.id,
    "role=system_admin",
    "page=1&page=2",
    "__proto__=x",
  ];
  for (const query of bad) {
    expect((await own(`?${query}`)).status, query).toBe(400);
    expect((await tasks(`?${query}`)).status, query).toBe(400);
  }
  expect((await own("?state=handled")).status).toBe(400);
  expect((await tasks("?state=cancelled")).status).toBe(400);
});

test("匿名、待确认、停用、过期会话与停用部门均不能读取两类列表", async () => {
  await submitted();
  for (const handler of [own, tasks]) {
    expect((await handler("", "")).status).toBe(401);
    expect((await handler("", people.pending.token)).status).toBe(403);
  }
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.owner.id],
  );
  await database().query(
    "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
    [people.finance.id],
  );
  for (const handler of [own, tasks]) {
    expect((await handler("", people.owner.token)).status).toBe(401);
    expect((await handler("", people.finance.token)).status).toBe(401);
  }
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    departmentId,
  ]);
  for (const handler of [own, tasks])
    expect((await handler("", people.head.token)).status).toBe(403);
});

test("角色移除和姓名变更不改写已提交列表快照或实际任务归属", async () => {
  const app = await submitted();
  const saved = await draft();
  await database().query(
    "UPDATE users SET full_name='已更名' WHERE id=ANY($1::uuid[])",
    [[people.owner.id, people.head.id]],
  );
  await database().query("UPDATE departments SET name='新部门名' WHERE id=$1", [
    departmentId,
  ]);
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='department_head'",
    [people.head.id],
  );
  const data = await ownData();
  expect(data.items.find((x) => x.id === app.application.id)).toMatchObject({
    applicant: { name: "owner", departmentName: "研发部" },
    currentTask: { approver: { name: "head" } },
  });
  expect(data.items.find((x) => x.id === saved.id)).toMatchObject({
    applicant: { name: "已更名", departmentName: "新部门名" },
  });
  expect((await taskData()).items[0].id).toBe(app.tasks[0].id);
  await decide(app);
  expect((await taskData("?state=handled")).total).toBe(1);
});

for (const handler of [own, tasks])
  test(`${handler === own ? "申请" : "任务"}列表等待组织锁后重新鉴权`, async () => {
    const gate = await database().connect();
    let pending: Promise<Response> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(72002)");
      pending = handler("", people.head.token);
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
      await gate.query("DELETE FROM sessions WHERE user_id=$1", [
        people.head.id,
      ]);
      await gate.query("COMMIT");
      expect((await pending).status).toBe(401);
    } finally {
      await gate.query("ROLLBACK");
      gate.release();
      await pending;
    }
  });

test("并发流转期间申请版本/当前节点/任务和总数来自同一快照", async () => {
  const app = await submitted();
  const gate = await database().connect();
  let ownPending: ReturnType<typeof ownData> | undefined;
  let tasksPending: ReturnType<typeof taskData> | undefined;
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT id FROM applications WHERE id=$1 FOR UPDATE", [
      app.application.id,
    ]);
    await gate.query("LOCK TABLE approval_tasks IN ACCESS EXCLUSIVE MODE");
    // Pause a state transition between its task/application writes. No reader may expose the partial state.
    await gate.query(
      "UPDATE approval_tasks SET status='approved',finished_at=clock_timestamp() WHERE id=$1",
      [app.tasks[0].id],
    );
    ownPending = ownData();
    tasksPending = taskData();
    let waiting = 0;
    for (let i = 0; i < 100; i++) {
      waiting = Number(
        (
          await gate.query(
            "SELECT count(*) FROM pg_locks WHERE relation='approval_tasks'::regclass AND NOT granted",
          )
        ).rows[0].count,
      );
      if (waiting >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBeGreaterThanOrEqual(2);
    await gate.query(
      "UPDATE approval_tasks SET status='pending',activated_at=clock_timestamp() WHERE id=$1",
      [app.tasks[1].id],
    );
    await gate.query("UPDATE applications SET version=3 WHERE id=$1", [
      app.application.id,
    ]);
    await gate.query("COMMIT");
    const ownResult = await ownPending;
    expect(ownResult.total).toBe(1);
    const item = ownResult.items[0];
    expect([2, 3]).toContain(item.version);
    expect(item.currentTask?.id).toBe(app.tasks[item.version === 2 ? 0 : 1].id);
    const taskResult = await tasksPending;
    expect(taskResult.total).toBe(taskResult.items.length);
    if (taskResult.total)
      expect(taskResult.items[0]).toMatchObject({
        id: app.tasks[0].id,
        status: "pending",
        application: { version: 2, currentTask: { id: app.tasks[0].id } },
      });
    expect((await taskData()).total).toBe(0);
    expect(
      (await taskData("", people.finance.token)).items[0].application.version,
    ).toBe(3);
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await Promise.allSettled([ownPending, tasksPending]);
  }
});

test("查询不更改申请/任务/日志/通知，连接重建与重复迁移后列表保持", async () => {
  await decide(await submitted());
  async function records() {
    return (
      await database().query(`SELECT jsonb_build_object(
      'apps',(SELECT jsonb_agg(a ORDER BY id) FROM applications a),
      'tasks',(SELECT jsonb_agg(t ORDER BY id) FROM approval_tasks t),
      'logs',(SELECT jsonb_agg(l ORDER BY id) FROM approval_logs l),
      'notifications',(SELECT jsonb_agg(n ORDER BY id) FROM notifications n)) AS records`)
    ).rows[0].records;
  }
  const before = await records();
  const apps = await ownData();
  const handled = await taskData("?state=handled");
  await taskData("", people.finance.token);
  expect(await records()).toEqual(before);
  await closeDatabase();
  await migrate();
  expect(await ownData()).toEqual(apps);
  expect(await taskData("?state=handled")).toEqual(handled);
});
