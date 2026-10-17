import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { changeUserAccess } from "../src/server/admin";
import {
  createTravelDraftHandler,
  replaceTravelDraftHandler,
  deleteTravelDraftHandler,
  getTravelDraftHandler,
} from "../src/server/travel-handlers";
import {
  submitTravelHandler,
  travelApplicationHandler,
} from "../src/server/travel-submission-handlers";

const origin = "http://localhost:3000";
const fields = {
  title: "差旅提交验收",
  departure: "杭州",
  destination: "上海",
  startDate: "2028-02-28",
  endDate: "2028-03-01",
  purpose: "客户交流",
  transportation: "高铁",
  budget: "0.00",
  companions: "",
  remarks: "",
};
const people: Record<string, { id: string; token: string }> = {};
let departmentId: string;
let financeDepartmentId: string;
function request(
  method = "GET",
  body?: unknown,
  token = people.owner.token,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/travel-drafts`, {
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
async function session(id: string) {
  const token = randomBytes(32).toString("hex");
  await database().query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
    [tokenHash(token), id],
  );
  return token;
}
async function draft(extra: Record<string, unknown> = {}) {
  const response = await createTravelDraftHandler(
    request("POST", { ...fields, ...extra }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data;
}
const submit = (id: string, version = 1, token = people.owner.token) =>
  submitTravelHandler(request("POST", { version }, token), context(id));
const detail = (id: string, token = people.owner.token) =>
  travelApplicationHandler(request("GET", undefined, token), context(id));
async function executionCounts() {
  const result = await database().query(`SELECT
    (SELECT count(*)::int FROM approval_instances) AS instances,
    (SELECT count(*)::int FROM approval_tasks) AS tasks,
    (SELECT count(*)::int FROM approval_logs) AS logs,
    (SELECT count(*)::int FROM notifications) AS notifications`);
  return result.rows[0];
}
const emptyExecution = { instances: 0, tasks: 0, logs: 0, notifications: 0 };
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = origin;
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await seedOrganization("Submission-test-password");
  departmentId = (
    await database().query("SELECT id FROM departments WHERE name='研发部'")
  ).rows[0].id;
  financeDepartmentId = (
    await database().query("SELECT id FROM departments WHERE name='财务部'")
  ).rows[0].id;
  const adminId = (
    await database().query("SELECT id FROM users WHERE username='admin'")
  ).rows[0].id;
  people.admin = { id: adminId, token: await session(adminId) };
  for (const username of [
    "owner",
    "head",
    "finance",
    "outsider",
    "unconfirmed",
  ]) {
    const id = (
      await database().query(
        `INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
       SELECT $1::text,$1::text,$1::text||'@example.invalid',password_hash,$2,
         CASE WHEN $1::text='unconfirmed' THEN NULL ELSE $2::uuid END,
         CASE WHEN $1::text='unconfirmed' THEN 'pending' ELSE 'active' END
       FROM users WHERE username='admin' RETURNING id`,
        [username, username === "finance" ? financeDepartmentId : departmentId],
      )
    ).rows[0].id;
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
      [id],
    );
    if (username === "head" || username === "finance") {
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, username === "head" ? "department_head" : "finance_approver"],
      );
    }
    people[username] = { id, token: await session(id) };
  }
});
afterAll(closeDatabase);

test("提交原子生成固定快照、唯一实例、首个待办、提交日志与首节点通知", async () => {
  const saved = await draft();
  const response = await submit(saved.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const value = (await response.json()).data;
  expect(value.application).toMatchObject({
    id: saved.id,
    appNo: saved.appNo,
    status: "pending",
    version: 2,
    departmentId,
    budget: "0.00",
    durationDays: 3,
  });
  expect(value.application.submittedAt).not.toBeNull();
  expect(value.workflow).toMatchObject({
    ruleVersion: "fixed-travel-v1",
    submittedVersion: 2,
    routeSnapshot: {
      applicant: { id: people.owner.id, departmentId },
      budget: "0.00",
      durationDays: 3,
      steps: [
        { seqNo: 1, approver: { id: people.head.id } },
        { seqNo: 2, approver: { id: people.finance.id } },
      ],
    },
  });
  expect(value.tasks).toMatchObject([
    { seqNo: 1, approverId: people.head.id, status: "pending" },
    { seqNo: 2, approverId: people.finance.id, status: "blocked" },
  ]);
  expect(value.logs).toMatchObject([
    {
      actorId: people.owner.id,
      taskId: null,
      action: "submitted",
      result: "pending",
      applicationVersion: 2,
    },
  ]);
  expect(await executionCounts()).toEqual({
    instances: 1,
    tasks: 2,
    logs: 1,
    notifications: 1,
  });
  const notice = (await database().query("SELECT * FROM notifications"))
    .rows[0];
  expect(notice).toMatchObject({
    recipient_id: people.head.id,
    app_id: saved.id,
    event_key: `task:${value.tasks[0].id}:pending`,
    kind: "approval.pending",
    read_at: null,
  });
  expect(
    (await getTravelDraftHandler(request(), context(saved.id))).status,
  ).toBe(409);
  expect(
    (
      await replaceTravelDraftHandler(
        request("PUT", { ...fields, version: 2 }),
        context(saved.id),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await deleteTravelDraftHandler(
        request("DELETE", { version: 2 }),
        context(saved.id),
      )
    ).status,
  ).toBe(409);
});

test("提交校验数据库中的完整字段，失败不改变草稿或生成任何执行记录", async () => {
  for (const extra of [
    { title: "" },
    { departure: "" },
    { destination: "" },
    { purpose: "" },
    { transportation: "" },
    { startDate: null },
    { endDate: null },
    { budget: null },
  ]) {
    const saved = await draft(extra);
    expect((await submit(saved.id)).status).toBe(400);
    expect(
      (await (await getTravelDraftHandler(request(), context(saved.id))).json())
        .data,
    ).toMatchObject({ status: "draft", version: 1, submittedAt: null });
  }
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("提交只收版本，不接受客户端审批人、状态、金额或正文替换", async () => {
  const saved = await draft();
  for (const extra of [
    { approverId: people.head.id },
    { status: "approved" },
    { departmentId },
    { budget: "1.00" },
    { title: "替换正文" },
    { routeSnapshot: {} },
  ]) {
    expect(
      (
        await submitTravelHandler(
          request("POST", { version: 1, ...extra }),
          context(saved.id),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (await submitTravelHandler(request("POST", {}), context(saved.id))).status,
  ).toBe(400);
  expect((await submit(saved.id, 2)).status).toBe(409);
  expect((await submit("not-a-uuid")).status).toBe(400);
  expect((await submit(randomUUID())).status).toBe(404);
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("提交和详情执行身份保护，非本人及管理员均不能替他人提交", async () => {
  const saved = await draft();
  for (const token of [
    people.admin.token,
    people.head.token,
    people.finance.token,
    people.outsider.token,
  ]) {
    expect((await submit(saved.id, 1, token)).status).toBe(404);
  }
  expect((await submit(saved.id, 1, people.unconfirmed.token)).status).toBe(
    403,
  );
  expect((await submit(saved.id, 1, "0".repeat(64))).status).toBe(401);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.owner.id],
  );
  expect((await submit(saved.id)).status).toBe(401);
  await database().query(
    "UPDATE users SET registration_status='active' WHERE id=$1",
    [people.owner.id],
  );
  await database().query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [tokenHash(people.owner.token)],
  );
  expect((await submit(saved.id)).status).toBe(401);
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("只有申请人及当前实际待办人员可读详情，后续节点及无关管理身份无权读取", async () => {
  const saved = await draft();
  expect((await detail(saved.id)).status).toBe(404);
  await submit(saved.id);
  for (const token of [people.owner.token, people.head.token])
    expect((await detail(saved.id, token)).status).toBe(200);
  for (const token of [
    people.finance.token,
    people.admin.token,
    people.outsider.token,
  ])
    expect((await detail(saved.id, token)).status).toBe(404);
  expect((await detail(saved.id, people.unconfirmed.token)).status).toBe(403);
  expect((await detail(saved.id, "0".repeat(64))).status).toBe(401);
  expect((await detail(randomUUID())).status).toBe(404);
});

test("审批人缺失、停用或部门不匹配时不静默跳过节点", async () => {
  const saved = await draft();
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.finance.id],
  );
  expect((await submit(saved.id)).status).toBe(409);
  await database().query(
    "UPDATE users SET registration_status='active' WHERE id=$1",
    [people.finance.id],
  );
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    financeDepartmentId,
  ]);
  expect((await submit(saved.id)).status).toBe(409);
  await database().query("UPDATE departments SET active=true WHERE id=$1", [
    financeDepartmentId,
  ]);
  await database().query("UPDATE users SET department_id=$2 WHERE id=$1", [
    people.head.id,
    financeDepartmentId,
  ]);
  expect((await submit(saved.id)).status).toBe(409);
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("多名有效候选拒绝提交，不按 UUID 或排序任意选择人员", async () => {
  const saved = await draft();
  for (const role of ["department_head", "finance_approver"]) {
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
      [people.outsider.id, role],
    );
    const response = await submit(saved.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("APPROVER_UNRESOLVED");
    await database().query(
      "DELETE FROM user_roles WHERE user_id=$1 AND role_code=$2",
      [people.outsider.id, role],
    );
  }
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("任何节点出现申请人本人都拒绝提交，不自行换人或略过自审", async () => {
  const saved = await draft();
  for (const [name, role] of [
    ["head", "department_head"],
    ["finance", "finance_approver"],
  ]) {
    await database().query(
      "DELETE FROM user_roles WHERE user_id=$1 AND role_code=$2",
      [people[name].id, role],
    );
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
      [people.owner.id, role],
    );
    const response = await submit(saved.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SELF_APPROVAL");
    await database().query(
      "DELETE FROM user_roles WHERE user_id=$1 AND role_code=$2",
      [people.owner.id, role],
    );
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
      [people[name].id, role],
    );
  }
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("并发或重试提交只产生一次流转、一个首待办和一条通知", async () => {
  const saved = await draft();
  const results = await Promise.all([submit(saved.id), submit(saved.id)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await submit(saved.id)).status).toBe(409);
  expect(await executionCounts()).toEqual({
    instances: 1,
    tasks: 2,
    logs: 1,
    notifications: 1,
  });
});

test("提交与草稿保存或删除竞争，只有一个请求成功且无部分执行记录", async () => {
  for (const operation of ["replace", "delete"]) {
    const saved = await draft();
    const before = await executionCounts();
    const competing =
      operation === "replace"
        ? replaceTravelDraftHandler(
            request("PUT", { ...fields, title: "另一个窗口", version: 1 }),
            context(saved.id),
          )
        : deleteTravelDraftHandler(
            request("DELETE", { version: 1 }),
            context(saved.id),
          );
    const results = await Promise.all([submit(saved.id), competing]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect([404, 409]).toContain(results.find((r) => r.status !== 200)!.status);
    const after = await executionCounts();
    const submitted = results[0].status === 200 ? 1 : 0;
    expect(after).toEqual({
      instances: before.instances + submitted,
      tasks: before.tasks + 2 * submitted,
      logs: before.logs + submitted,
      notifications: before.notifications + submitted,
    });
  }
});

test("实例、第二节点、日志或通知任一步失败都回滚申请状态和全部新增记录", async () => {
  for (const [table, condition] of [
    ["approval_instances", "rule_version<>'fixed-travel-v1'"],
    ["approval_tasks", "seq_no<>2"],
    ["approval_logs", "action<>'submitted'"],
    ["notifications", "kind<>'approval.pending'"],
  ]) {
    const saved = await draft();
    await database().query(
      `ALTER TABLE ${table} ADD CONSTRAINT test_reject_submission CHECK (${condition})`,
    );
    try {
      expect((await submit(saved.id)).status).toBe(500);
      expect(await executionCounts()).toEqual(emptyExecution);
      expect(
        (
          await (
            await getTravelDraftHandler(request(), context(saved.id))
          ).json()
        ).data,
      ).toEqual(saved);
    } finally {
      await database().query(
        `ALTER TABLE ${table} DROP CONSTRAINT test_reject_submission`,
      );
    }
  }
});

test("提交时使用最新确认部门，提交后授权与人员变更不改写已有路径快照", async () => {
  const saved = await draft();
  await changeUserAccess(people.admin.token, people.owner.id, {
    departmentId: financeDepartmentId,
    status: "active",
    roles: ["employee"],
    reason: "提交前部门变更",
  });
  people.owner.token = await session(people.owner.id);
  await changeUserAccess(people.admin.token, people.head.id, {
    departmentId: financeDepartmentId,
    status: "active",
    roles: ["employee", "department_head"],
    reason: "确认新部门负责人",
  });
  const result = (await (await submit(saved.id)).json()).data;
  expect(result.application.departmentId).toBe(financeDepartmentId);
  expect(result.workflow.routeSnapshot.applicant.departmentId).toBe(
    financeDepartmentId,
  );
  await changeUserAccess(people.admin.token, people.head.id, {
    departmentId,
    status: "active",
    roles: ["employee"],
    reason: "后续组织调整",
  });
  await changeUserAccess(people.admin.token, people.outsider.id, {
    departmentId: financeDepartmentId,
    status: "active",
    roles: ["employee", "department_head"],
    reason: "新负责人",
  });
  people.head.token = await session(people.head.id);
  people.outsider.token = await session(people.outsider.id);
  const after = (await (await detail(saved.id)).json()).data;
  expect(after).toEqual(result);
  expect((await detail(saved.id, people.head.token)).status).toBe(200);
  expect((await detail(saved.id, people.outsider.token)).status).toBe(404);
});

test("历史不可改删；首待办和通知唯一约束阻止重复记录，迁移后快照仍可查询", async () => {
  const saved = await draft();
  const result = (await (await submit(saved.id)).json()).data;
  for (const table of ["approval_instances", "approval_logs"]) {
    await expect(
      database().query(`DELETE FROM ${table}`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database().query(`UPDATE ${table} SET created_at=now()`),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expect(
    database().query(
      "UPDATE approval_tasks SET status='pending',activated_at=clock_timestamp() WHERE instance_id=$1 AND seq_no=2",
      [result.workflow.id],
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    database().query(
      "INSERT INTO notifications(recipient_id,app_id,event_key,kind,title) SELECT recipient_id,app_id,event_key,kind,title FROM notifications",
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await migrate();
  await closeDatabase();
  expect((await (await detail(saved.id)).json()).data).toEqual(result);
});

test("等待组织锁后读取新的审批人授权，失效配置不能抢先提交", async () => {
  const saved = await draft();
  const client = await database().connect();
  let pending: Promise<Response> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72002)");
    pending = submit(saved.id);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=72002 AND NOT granted) AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await client.query(
      "DELETE FROM user_roles WHERE user_id=$1 AND role_code='finance_approver'",
      [people.finance.id],
    );
    await client.query("COMMIT");
    expect((await pending).status).toBe(409);
    expect(await executionCounts()).toEqual(emptyExecution);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pending;
  }
});

test("提交拒绝无同源 Origin 的 Cookie、跨站请求与错误正文类型", async () => {
  const saved = await draft();
  const cookieHeaders: Record<string, string>[] = [
    { Cookie: `approval_session=${people.owner.token}` },
    {
      Cookie: `approval_session=${people.owner.token}`,
      Origin: "https://example.invalid",
    },
  ];
  for (const headers of cookieHeaders) {
    expect(
      (
        await submitTravelHandler(
          request("POST", { version: 1 }, "", headers),
          context(saved.id),
        )
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await submitTravelHandler(
        request("POST", { version: 1 }, people.owner.token, {
          "Content-Type": "text/plain",
        }),
        context(saved.id),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await submitTravelHandler(
        request("POST", { version: 1 }, "", {
          Cookie: `approval_session=${people.owner.token}`,
          Origin: origin,
        }),
        context(saved.id),
      )
    ).status,
  ).toBe(200);
});
