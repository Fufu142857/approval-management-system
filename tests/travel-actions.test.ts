import {
  travelDecisionHandler,
  travelWithdrawalHandler,
} from "../src/server/travel-action-handlers";
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

const decide = (
  value: Awaited<
    ReturnType<
      typeof import("../src/server/travel-submission").getTravelApplication
    >
  >,
  index = 0,
  decision = "approve",
  version = value.application.version,
  token = people.head.token,
  opinion = "",
) =>
  travelDecisionHandler(
    request("POST", { version, decision, opinion }, token),
    {
      params: Promise.resolve({
        id: value.application.id,
        taskId: value.tasks[index].id,
      }),
    },
  );
const withdraw = (
  value: Awaited<
    ReturnType<
      typeof import("../src/server/travel-submission").getTravelApplication
    >
  >,
  version = value.application.version,
  token = people.owner.token,
) =>
  travelWithdrawalHandler(
    request("POST", { version, opinion: "计划调整" }, token),
    context(value.application.id),
  );
async function pending() {
  const saved = await draft();
  const response = await submit(saved.id);
  expect(response.status).toBe(200);
  return (await response.json()).data;
}
async function notices(id: string) {
  return (
    await database().query(
      "SELECT recipient_id,kind,event_key FROM notifications WHERE app_id=$1 ORDER BY created_at,id",
      [id],
    )
  ).rows;
}

test("两步顺序通过，状态/版本/日志/通知一致，已办人员仍可查看终态", async () => {
  const initial = await pending();
  const first = await decide(
    initial,
    0,
    "approve",
    2,
    people.head.token,
    "  同意出差  ",
  );
  expect(first.status).toBe(200);
  const middle = (await first.json()).data;
  expect(middle.application).toMatchObject({ status: "pending", version: 3 });
  expect(middle.tasks.map((t: { status: string }) => t.status)).toEqual([
    "approved",
    "pending",
  ]);
  expect(middle.logs[1]).toMatchObject({
    taskId: initial.tasks[0].id,
    actorId: people.head.id,
    action: "approved",
    opinion: "同意出差",
    result: "pending",
    applicationVersion: 3,
  });
  expect(middle.tasks[0].finishedAt).not.toBeNull();
  expect(middle.tasks[1].activatedAt).not.toBeNull();
  expect((await detail(initial.application.id, people.head.token)).status).toBe(
    200,
  );
  const finalResponse = await decide(
    middle,
    1,
    "approve",
    3,
    people.finance.token,
  );
  expect(finalResponse.status).toBe(200);
  const final = (await finalResponse.json()).data;
  expect(final.application).toMatchObject({ status: "approved", version: 4 });
  expect(final.workflow).toEqual(initial.workflow);
  expect(
    final.logs.map((l: { applicationVersion: number }) => l.applicationVersion),
  ).toEqual([2, 3, 4]);
  expect(
    (await notices(initial.application.id)).map((n) => [
      n.recipient_id,
      n.kind,
    ]),
  ).toEqual([
    [people.head.id, "approval.pending"],
    [people.finance.id, "approval.pending"],
    [people.owner.id, "application.approved"],
  ]);
  for (const token of [
    people.owner.token,
    people.head.token,
    people.finance.token,
  ])
    expect((await detail(initial.application.id, token)).status).toBe(200);
  expect(
    (await detail(initial.application.id, people.admin.token)).status,
  ).toBe(404);
  expect((await withdraw(final, 4)).status).toBe(409);
  expect(
    (await decide(final, 1, "approve", 4, people.finance.token)).status,
  ).toBe(409);
  expect(
    (
      await replaceTravelDraftHandler(
        request("PUT", { ...fields, version: 4 }),
        context(final.application.id),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await deleteTravelDraftHandler(
        request("DELETE", { version: 4 }),
        context(final.application.id),
      )
    ).status,
  ).toBe(409);
  expect(
    (await getTravelDraftHandler(request(), context(final.application.id)))
      .status,
  ).toBe(409);
  await closeDatabase();
  expect((await (await detail(final.application.id)).json()).data).toEqual(
    final,
  );
});

test("首节点或末节点驳回结束流程并保留必填理由，不激活后续任务", async () => {
  for (const index of [0, 1]) {
    let value = await pending();
    if (index === 1) value = (await (await decide(value)).json()).data;
    const response = await decide(
      value,
      index,
      "reject",
      value.application.version,
      index ? people.finance.token : people.head.token,
      "  预算需补充  ",
    );
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.application.status).toBe("rejected");
    expect(result.tasks.map((t: { status: string }) => t.status)).toEqual(
      index ? ["approved", "rejected"] : ["rejected", "cancelled"],
    );
    expect(result.logs.at(-1)).toMatchObject({
      action: "rejected",
      opinion: "预算需补充",
      result: "rejected",
    });
    expect((await notices(result.application.id)).at(-1)).toMatchObject({
      recipient_id: people.owner.id,
      kind: "application.rejected",
    });
    expect((await withdraw(result)).status).toBe(409);
    expect(
      (
        await decide(
          result,
          index,
          "approve",
          result.application.version,
          index ? people.finance.token : people.head.token,
        )
      ).status,
    ).toBe(409);
    if (!index)
      expect(
        (await detail(result.application.id, people.finance.token)).status,
      ).toBe(404);
  }
});

test("撤回首节点或第二节点取消未办任务，保留已办并只通知实际接触过的人员", async () => {
  for (const afterFirst of [false, true]) {
    let value = await pending();
    if (afterFirst) value = (await (await decide(value)).json()).data;
    const response = await withdraw(value);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.application.status).toBe("withdrawn");
    expect(result.tasks.map((t: { status: string }) => t.status)).toEqual(
      afterFirst ? ["approved", "cancelled"] : ["cancelled", "cancelled"],
    );
    expect(result.logs.at(-1)).toMatchObject({
      action: "withdrawn",
      actorId: people.owner.id,
      taskId: value.tasks[afterFirst ? 1 : 0].id,
    });
    const recipients = (await notices(value.application.id))
      .filter((n) => n.kind === "application.withdrawn")
      .map((n) => n.recipient_id)
      .sort();
    expect(recipients).toEqual(
      [
        people.owner.id,
        people.head.id,
        ...(afterFirst ? [people.finance.id] : []),
      ].sort(),
    );
    expect((await detail(value.application.id, people.head.token)).status).toBe(
      200,
    );
    expect(
      (await detail(value.application.id, people.finance.token)).status,
    ).toBe(afterFirst ? 200 : 404);
    expect((await withdraw(result)).status).toBe(409);
    expect((await decide(result)).status).toBe(409);
  }
});

test("阻止自审、管理身份、他人任务、未来节点和越权撤回", async () => {
  const value = await pending();
  expect(
    (await decide(value, 0, "approve", 2, people.owner.token)).status,
  ).toBe(403);
  for (const token of [
    people.admin.token,
    people.outsider.token,
    people.finance.token,
  ]) {
    expect((await decide(value, 0, "approve", 2, token)).status).toBe(404);
    expect((await withdraw(value, 2, token)).status).toBe(404);
  }
  expect(
    (await decide(value, 1, "approve", 2, people.finance.token)).status,
  ).toBe(409);
  expect(
    (await decide(value, 0, "approve", 2, people.unconfirmed.token)).status,
  ).toBe(403);
  expect((await decide(value, 0, "approve", 2, "0".repeat(64))).status).toBe(
    401,
  );
  expect(await executionCounts()).toEqual({
    instances: 1,
    tasks: 2,
    logs: 1,
    notifications: 1,
  });
});

test("严格输入、驳回理由与 Cookie 来源检查；失败不产生流转", async () => {
  const value = await pending();
  const ctx = {
    params: Promise.resolve({
      id: value.application.id,
      taskId: value.tasks[0].id,
    }),
  };
  for (const body of [
    { version: 2, decision: "reject" },
    { version: 2, decision: "reject", opinion: "  " },
    { version: 2, decision: "approve", opinion: "x".repeat(2001) },
    { version: 2, decision: "approve", approverId: people.head.id },
    { decision: "approve" },
    { version: 0, decision: "approve" },
    { version: 2, decision: "withdraw" },
  ])
    expect(
      (
        await travelDecisionHandler(
          request("POST", body, people.head.token),
          ctx,
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await travelDecisionHandler(
        request("POST", { version: 2, decision: "approve" }, "", {
          Cookie: `approval_session=${people.head.token}`,
        }),
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await travelDecisionHandler(
        request(
          "POST",
          { version: 2, decision: "approve" },
          people.head.token,
          { Origin: "https://example.invalid" },
        ),
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await travelWithdrawalHandler(
        request("POST", { version: 2, status: "approved" }),
        context(value.application.id),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await travelWithdrawalHandler(
        request("POST", { version: 2 }, "", {
          Cookie: `approval_session=${people.owner.token}`,
        }),
        context(value.application.id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await travelWithdrawalHandler(
        request("POST", { version: 2 }, people.owner.token, {
          "Content-Type": "text/plain",
        }),
        context(value.application.id),
      )
    ).status,
  ).toBe(415);
  expect(await executionCounts()).toEqual({
    instances: 1,
    tasks: 2,
    logs: 1,
    notifications: 1,
  });
  expect(
    (
      await travelDecisionHandler(
        request("POST", { version: 2, decision: "approve" }, "", {
          Cookie: `approval_session=${people.head.token}`,
          Origin: origin,
        }),
        ctx,
      )
    ).status,
  ).toBe(200);
});

test("重复和相反审批竞争只允许一次流转与通知", async () => {
  for (const second of ["approve", "reject"]) {
    const value = await pending();
    const results = await Promise.all([
      decide(value),
      decide(value, 0, second, 2, people.head.token, "不批准"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = (await (await detail(value.application.id)).json()).data;
    expect(after.application.version).toBe(3);
    expect(after.logs).toHaveLength(2);
    expect(await notices(value.application.id)).toHaveLength(2);
  }
});

test("首节点和末节点审批与撤回竞争都只有一方成功", async () => {
  for (const secondNode of [false, true]) {
    let value = await pending();
    if (secondNode) value = (await (await decide(value)).json()).data;
    const results = await Promise.all([
      decide(
        value,
        secondNode ? 1 : 0,
        "approve",
        value.application.version,
        secondNode ? people.finance.token : people.head.token,
      ),
      withdraw(value),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = (await (await detail(value.application.id)).json()).data;
    expect(after.application.version).toBe(value.application.version + 1);
    expect(after.logs).toHaveLength(value.logs.length + 1);
    expect(
      after.tasks.filter((t: { status: string }) => t.status === "pending")
        .length,
    ).toBe(after.application.status === "pending" ? 1 : 0);
  }
});

test("同一人负责两个节点时旧任务 ID 不能处理下一步，撤回通知按人去重", async () => {
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='finance_approver'",
    [people.finance.id],
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'finance_approver')",
    [people.head.id],
  );
  const value = await pending();
  const middle = (await (await decide(value)).json()).data;
  expect((await decide(value, 0, "approve", 3)).status).toBe(409);
  const other = await pending();
  const cross = await travelDecisionHandler(
    request("POST", { version: 2, decision: "approve" }, people.head.token),
    {
      params: Promise.resolve({
        id: other.application.id,
        taskId: value.tasks[1].id,
      }),
    },
  );
  expect(cross.status).toBe(404);
  expect((await withdraw(middle)).status).toBe(200);
  expect(
    (await notices(value.application.id)).filter(
      (n) => n.kind === "application.withdrawn",
    ),
  ).toHaveLength(2);
});

test("旧版本、无效 ID、草稿和版本上限拒绝操作", async () => {
  const value = await pending();
  expect((await decide(value, 0, "approve", 1)).status).toBe(409);
  expect((await withdraw(value, 1)).status).toBe(409);
  for (const id of [randomUUID(), "bad-id"]) {
    expect(
      (
        await travelWithdrawalHandler(
          request("POST", { version: 2 }),
          context(id),
        )
      ).status,
    ).toBe(id === "bad-id" ? 400 : 404);
  }
  const saved = await draft();
  expect(
    (
      await travelWithdrawalHandler(
        request("POST", { version: 1 }),
        context(saved.id),
      )
    ).status,
  ).toBe(409);
  await database().query(
    "UPDATE applications SET version=2147483647 WHERE id=$1",
    [value.application.id],
  );
  expect((await decide(value, 0, "approve", 2147483647)).status).toBe(409);
  expect((await withdraw(value, 2147483647)).status).toBe(409);
});

test("已冻结人员保留审批权；下一审批人停用不跳过、不换人或部分批准", async () => {
  const value = await pending();
  await changeUserAccess(people.admin.token, people.head.id, {
    departmentId,
    status: "active",
    roles: ["employee"],
    reason: "负责人变动",
  });
  people.head.token = await session(people.head.id);
  await changeUserAccess(people.admin.token, people.finance.id, {
    departmentId: financeDepartmentId,
    status: "disabled",
    roles: ["employee"],
    reason: "账号停用",
  });
  const response = await decide(value);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("APPROVER_UNAVAILABLE");
  expect((await (await detail(value.application.id)).json()).data).toEqual(
    value,
  );
  await changeUserAccess(people.admin.token, people.finance.id, {
    departmentId: financeDepartmentId,
    status: "active",
    roles: ["employee"],
    reason: "恢复冻结人员账号",
  });
  people.finance.token = await session(people.finance.id);
  const middle = (await (await decide(value)).json()).data;
  expect(
    (await decide(middle, 1, "approve", 3, people.finance.token)).status,
  ).toBe(200);
});

test("审批/驳回/撤回在任务、主表、日志或通知失败时完整回滚", async () => {
  for (const operation of ["approve", "reject", "withdraw"]) {
    for (const [table, condition] of [
      ["approval_tasks", "finished_at IS NULL"],
      ["applications", "version<3"],
      ["approval_logs", "action='submitted'"],
      [
        "notifications",
        "kind='approval.pending' AND recipient_id='00000000-0000-0000-0000-000000000000'",
      ],
    ]) {
      const value = await pending();
      const beforeNotices = await notices(value.application.id);
      // NOT VALID permits old fixture rows; newly changed rows must satisfy the constraint.
      await database().query(
        `ALTER TABLE ${table} ADD CONSTRAINT test_action_failure CHECK (${condition}) NOT VALID`,
      );
      try {
        const response =
          operation === "withdraw"
            ? await withdraw(value)
            : await decide(
                value,
                0,
                operation,
                2,
                people.head.token,
                "拒绝原因",
              );
        expect(response.status).toBe(500);
        expect(
          (await (await detail(value.application.id)).json()).data,
        ).toEqual(value);
        expect(await notices(value.application.id)).toEqual(beforeNotices);
      } finally {
        await database().query(
          `ALTER TABLE ${table} DROP CONSTRAINT test_action_failure`,
        );
      }
    }
  }
});

async function waitForLock(query: string, parameters: unknown[] = []) {
  for (let i = 0; i < 100; i++) {
    if ((await database().query(query, parameters)).rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected database lock wait was not observed");
}

test("详情等待正在流转的申请锁，返回同一状态的任务与日志", async () => {
  const value = await pending();
  const gate = await database().connect();
  let writer: Promise<Response> | undefined;
  let reader: Promise<Response> | undefined;
  await database()
    .query(`CREATE FUNCTION test_pause_action() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(72003); RETURN NEW; END; $$`);
  await database().query(
    "CREATE TRIGGER test_pause_action BEFORE INSERT ON approval_logs FOR EACH ROW EXECUTE FUNCTION test_pause_action()",
  );
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(72003)");
    writer = decide(value);
    await waitForLock(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=72003 AND NOT granted) AS waiting",
    );
    reader = detail(value.application.id);
    await waitForLock(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE 'SELECT id FROM applications WHERE id=%' AND wait_event_type='Lock') AS waiting",
    );
    await gate.query("COMMIT");
    const written = await writer;
    const read = await reader;
    expect(written.status).toBe(200);
    expect(read.status).toBe(200);
    expect((await read.json()).data).toEqual((await written.json()).data);
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await Promise.all([writer, reader]);
    await database().query("DROP TRIGGER test_pause_action ON approval_logs");
    await database().query("DROP FUNCTION test_pause_action()");
  }
});

test("等待组织授权锁后重新验证会话，停用审批人不能抢先批准", async () => {
  const value = await pending();
  const gate = await database().connect();
  let writer: Promise<Response> | undefined;
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(72002)");
    writer = decide(value);
    await waitForLock(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=72002 AND NOT granted) AS waiting",
    );
    await gate.query(
      "UPDATE users SET registration_status='disabled' WHERE id=$1",
      [people.head.id],
    );
    await gate.query("DELETE FROM sessions WHERE user_id=$1", [people.head.id]);
    await gate.query("COMMIT");
    expect((await writer).status).toBe(401);
    expect((await (await detail(value.application.id)).json()).data).toEqual(
      value,
    );
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await writer;
  }
});

test("重复撤回并发只追加一条日志和每个接收人的一条通知", async () => {
  const value = await pending();
  const results = await Promise.all([withdraw(value), withdraw(value)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const after = (await (await detail(value.application.id)).json()).data;
  expect(after.logs).toHaveLength(2);
  expect(
    (await notices(value.application.id)).filter(
      (n) => n.kind === "application.withdrawn",
    ),
  ).toHaveLength(2);
});
