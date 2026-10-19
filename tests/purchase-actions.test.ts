import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  uploadPurchaseAttachment,
  deletePurchaseAttachment,
} from "../src/server/purchase-attachments";
import {
  submittedPurchaseAttachmentsHandler,
  submittedPurchaseAttachmentContentHandler,
} from "../src/server/purchase-attachment-handlers";
import { getNotification } from "../src/server/notifications";
import { createTravelDraft } from "../src/server/travel";
import { travelDraftSchema } from "../src/lib/travel";
import {
  travelDecisionHandler,
  travelWithdrawalHandler,
} from "../src/server/travel-action-handlers";
import {
  purchaseDecisionHandler,
  purchaseWithdrawalHandler,
} from "../src/server/purchase-action-handlers";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { changeUserAccess } from "../src/server/admin";
import {
  createPurchaseDraftHandler,
  replacePurchaseDraftHandler,
  deletePurchaseDraftHandler,
  getPurchaseDraftHandler,
} from "../src/server/purchase-handlers";
import {
  submitPurchaseHandler,
  purchaseApplicationHandler,
} from "../src/server/purchase-submission-handlers";

const origin = "http://localhost:3000";
const fields = {
  title: "采购提交验收",
  reason: "设备更新",
  expectedDate: "2028-02-29",
  budgetLimit: "1000.00",
  selectionReason: "综合质量与交货期限",
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
const people: Record<string, { id: string; token: string }> = {};
const storage = resolve("tmp/attachments-vitest-test");
let png: Buffer;
let departmentId: string;
let companyDepartmentId: string;
function request(
  method = "GET",
  body?: unknown,
  token = people.owner.token,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/purchase-drafts`, {
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
  const response = await createPurchaseDraftHandler(
    request("POST", { ...fields, ...extra }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data;
}
const submit = (id: string, version = 1, token = people.owner.token) =>
  submitPurchaseHandler(request("POST", { version }, token), context(id));
const detail = (id: string, token = people.owner.token) =>
  purchaseApplicationHandler(request("GET", undefined, token), context(id));
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
  process.env.ATTACHMENT_STORAGE_DIR = storage;
  png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await rm(storage, { recursive: true, force: true });
  await mkdir(storage, { recursive: true });
  await seedOrganization("Submission-test-password");
  departmentId = (
    await database().query("SELECT id FROM departments WHERE name='研发部'")
  ).rows[0].id;
  companyDepartmentId = (
    await database().query("SELECT id FROM departments WHERE name='财务部'")
  ).rows[0].id;
  const adminId = (
    await database().query("SELECT id FROM users WHERE username='admin'")
  ).rows[0].id;
  people.admin = { id: adminId, token: await session(adminId) };
  for (const username of [
    "owner",
    "head",
    "companyhead",
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
        [
          username,
          username === "companyhead" ? companyDepartmentId : departmentId,
        ],
      )
    ).rows[0].id;
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
      [id],
    );
    if (username === "head" || username === "companyhead") {
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, username === "head" ? "department_head" : "company_head"],
      );
    }
    people[username] = { id, token: await session(id) };
  }
});
afterAll(async () => {
  await closeDatabase();
  await rm(storage, { recursive: true, force: true });
});

const decide = (
  value: Awaited<
    ReturnType<
      typeof import("../src/server/purchase-submission").getPurchaseApplication
    >
  >,
  index = 0,
  decision = "approve",
  version = value.application.version,
  token = people.head.token,
  opinion = "",
) =>
  purchaseDecisionHandler(
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
      typeof import("../src/server/purchase-submission").getPurchaseApplication
    >
  >,
  version = value.application.version,
  token = people.owner.token,
) =>
  purchaseWithdrawalHandler(
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
    "  同意采购  ",
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
    opinion: "同意采购",
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
    people.companyhead.token,
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
    [people.companyhead.id, "approval.pending"],
    [people.owner.id, "application.approved"],
  ]);
  for (const token of [
    people.owner.token,
    people.head.token,
    people.companyhead.token,
  ])
    expect((await detail(initial.application.id, token)).status).toBe(200);
  expect(
    (await detail(initial.application.id, people.admin.token)).status,
  ).toBe(404);
  expect((await withdraw(final, 4)).status).toBe(409);
  expect(
    (await decide(final, 1, "approve", 4, people.companyhead.token)).status,
  ).toBe(409);
  expect(
    (
      await replacePurchaseDraftHandler(
        request("PUT", { ...fields, version: 4 }),
        context(final.application.id),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await deletePurchaseDraftHandler(
        request("DELETE", { version: 4 }),
        context(final.application.id),
      )
    ).status,
  ).toBe(409);
  expect(
    (await getPurchaseDraftHandler(request(), context(final.application.id)))
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
      index ? people.companyhead.token : people.head.token,
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
          index ? people.companyhead.token : people.head.token,
        )
      ).status,
    ).toBe(409);
    if (!index)
      expect(
        (await detail(result.application.id, people.companyhead.token)).status,
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
        ...(afterFirst ? [people.companyhead.id] : []),
      ].sort(),
    );
    expect((await detail(value.application.id, people.head.token)).status).toBe(
      200,
    );
    expect(
      (await detail(value.application.id, people.companyhead.token)).status,
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
    people.companyhead.token,
  ]) {
    expect((await decide(value, 0, "approve", 2, token)).status).toBe(404);
    expect((await withdraw(value, 2, token)).status).toBe(404);
  }
  expect(
    (await decide(value, 1, "approve", 2, people.companyhead.token)).status,
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
        await purchaseDecisionHandler(
          request("POST", body, people.head.token),
          ctx,
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await purchaseDecisionHandler(
        request("POST", { version: 2, decision: "approve" }, "", {
          Cookie: `approval_session=${people.head.token}`,
        }),
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await purchaseDecisionHandler(
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
      await purchaseWithdrawalHandler(
        request("POST", { version: 2, status: "approved" }),
        context(value.application.id),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await purchaseWithdrawalHandler(
        request("POST", { version: 2 }, "", {
          Cookie: `approval_session=${people.owner.token}`,
        }),
        context(value.application.id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await purchaseWithdrawalHandler(
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
      await purchaseDecisionHandler(
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
        secondNode ? people.companyhead.token : people.head.token,
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
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='company_head'",
    [people.companyhead.id],
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'company_head')",
    [people.head.id],
  );
  const value = await pending();
  const middle = (await (await decide(value)).json()).data;
  expect((await decide(value, 0, "approve", 3)).status).toBe(409);
  const other = await pending();
  const cross = await purchaseDecisionHandler(
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
        await purchaseWithdrawalHandler(
          request("POST", { version: 2 }),
          context(id),
        )
      ).status,
    ).toBe(id === "bad-id" ? 400 : 404);
  }
  const saved = await draft();
  expect(
    (
      await purchaseWithdrawalHandler(
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
  await changeUserAccess(people.admin.token, people.companyhead.id, {
    departmentId: companyDepartmentId,
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
  await changeUserAccess(people.admin.token, people.companyhead.id, {
    departmentId: companyDepartmentId,
    status: "active",
    roles: ["employee"],
    reason: "恢复冻结人员账号",
  });
  people.companyhead.token = await session(people.companyhead.id);
  const middle = (await (await decide(value)).json()).data;
  expect(
    (await decide(middle, 1, "approve", 3, people.companyhead.token)).status,
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

async function withFile() {
  const saved = await draft();
  const uploaded = await uploadPurchaseAttachment(
    people.owner.token,
    saved.id,
    saved.quotes[0].id,
    1,
    png,
    "报价.png",
    "image/png",
  );
  const response = await submit(saved.id, uploaded.version);
  expect(response.status).toBe(200);
  return { value: (await response.json()).data, file: uploaded.attachment };
}
const fileContext = (id: string, attachmentId?: string) => ({
  params: Promise.resolve({ id, attachmentId }),
});
const files = (id: string, token: string) =>
  submittedPurchaseAttachmentsHandler(
    request("GET", undefined, token),
    context(id),
  );
const content = (id: string, fileId: string, token: string) =>
  submittedPurchaseAttachmentContentHandler(
    request("GET", undefined, token),
    fileContext(id, fileId),
  );

test("采购各终态保持报价明细/快照/附件，已激活人员保留原文件访问，未激活人员始终无权", async () => {
  for (const action of [
    "approved",
    "reject-first",
    "reject-last",
    "withdraw-first",
    "withdraw-last",
  ]) {
    const { value: initial, file } = await withFile();
    expect(
      (await content(initial.application.id, file.id, people.companyhead.token))
        .status,
    ).toBe(404);
    let current = initial;
    const activated = ["approved", "reject-last", "withdraw-last"].includes(
      action,
    );
    if (activated) {
      const response = await decide(current);
      expect(response.status).toBe(200);
      current = (await response.json()).data;
      expect(
        (
          await content(
            current.application.id,
            file.id,
            people.companyhead.token,
          )
        ).status,
      ).toBe(200);
    }
    const response = action.startsWith("withdraw")
      ? await withdraw(current)
      : await decide(
          current,
          activated ? 1 : 0,
          action === "approved" ? "approve" : "reject",
          current.application.version,
          activated ? people.companyhead.token : people.head.token,
          "不符合采购条件",
        );
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.workflow).toEqual(initial.workflow);
    for (const field of [
      "items",
      "quotes",
      "budgetLimit",
      "totalAmount",
      "selectionReason",
      "singleSource",
      "singleSourceReason",
      "appNo",
      "submittedAt",
    ])
      expect(result.application[field]).toEqual(initial.application[field]);
    for (const name of ["owner", "head", "companyhead", "admin", "outsider"]) {
      const allowed =
        ["owner", "head"].includes(name) ||
        (name === "companyhead" && activated);
      const listing = await files(result.application.id, people[name].token);
      expect(listing.status).toBe(allowed ? 200 : 404);
      if (allowed)
        expect((await listing.json()).data).toMatchObject({
          items: [file],
          status: result.application.status,
          version: result.application.version,
        });
      const download = await content(
        result.application.id,
        file.id,
        people[name].token,
      );
      expect(download.status).toBe(allowed ? 200 : 404);
      if (allowed)
        expect(Buffer.from(await download.arrayBuffer())).toEqual(png);
    }
    await expect(
      deletePurchaseAttachment(
        people.owner.token,
        result.application.id,
        file.id,
        result.application.version,
      ),
    ).rejects.toMatchObject({ code: "NOT_DRAFT" });
    const rows = (
      await database().query(
        "SELECT id,recipient_id FROM notifications WHERE app_id=$1",
        [result.application.id],
      )
    ).rows;
    for (const row of rows) {
      const actor = Object.values(people).find(
        (p) => p.id === row.recipient_id,
      )!;
      const notice = await getNotification(actor.token, row.id);
      expect(notice.target).toMatchObject({
        type: "purchase",
        status: result.application.status,
        apiPath: `/api/purchase-applications/${result.application.id}`,
      });
      if (notice.task) expect(notice.task.status).not.toBe("pending");
    }
  }
});

test("采购与差旅动作相互隔离，财务角色不能代替企业负责人", async () => {
  const value = await pending();
  const ctx = {
    params: Promise.resolve({
      id: value.application.id,
      taskId: value.tasks[0].id,
    }),
  };
  expect(
    (
      await travelDecisionHandler(
        request("POST", { version: 2, decision: "approve" }, people.head.token),
        ctx,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await travelWithdrawalHandler(
        request("POST", { version: 2 }),
        context(value.application.id),
      )
    ).status,
  ).toBe(404);
  const travel = await createTravelDraft(
    people.owner.token,
    travelDraftSchema.parse({ title: "差旅草稿" }),
  );
  expect(
    (
      await purchaseWithdrawalHandler(
        request("POST", { version: 1 }),
        context(travel.id),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await purchaseDecisionHandler(
        request("POST", { version: 1, decision: "approve" }, people.head.token),
        {
          params: Promise.resolve({ id: travel.id, taskId: value.tasks[0].id }),
        },
      )
    ).status,
  ).toBe(404);
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'finance_approver')",
    [people.outsider.id],
  );
  const middle = (await (await decide(value)).json()).data;
  expect(
    (await decide(middle, 1, "approve", 3, people.outsider.token)).status,
  ).toBe(404);
  expect(
    (await decide(middle, 1, "approve", 3, people.companyhead.token)).status,
  ).toBe(200);
});

test("新增企业负责人不能替代原快照人员，下一人员部门无效时批准整体回滚但仍可驳回", async () => {
  const value = await pending();
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'company_head')",
    [people.outsider.id],
  );
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    companyDepartmentId,
  ]);
  const response = await decide(value);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("APPROVER_UNAVAILABLE");
  expect((await (await detail(value.application.id)).json()).data).toEqual(
    value,
  );
  expect(
    (await decide(value, 1, "approve", 2, people.outsider.token)).status,
  ).toBe(404);
  const rejected = await decide(
    value,
    0,
    "reject",
    2,
    people.head.token,
    "下一审批人不可用，退回核验",
  );
  expect(rejected.status).toBe(200);
  expect((await rejected.json()).data.application.status).toBe("rejected");
});

test("企业负责人在批准事务完成前的正文/文件读取等待同一申请锁，随后按新激活权限读取", async () => {
  const { value, file } = await withFile();
  const gate = await database().connect();
  let writer: Promise<Response> | undefined,
    reader: Promise<Response> | undefined,
    download: Promise<Response> | undefined;
  await database()
    .query(`CREATE FUNCTION test_pause_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(72003); RETURN NEW; END; $$`);
  await database().query(
    "CREATE TRIGGER test_pause_purchase BEFORE INSERT ON approval_logs FOR EACH ROW EXECUTE FUNCTION test_pause_purchase()",
  );
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(72003)");
    writer = decide(value);
    await waitForLock(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=72003 AND NOT granted) AS waiting",
    );
    reader = detail(value.application.id, people.companyhead.token);
    download = content(value.application.id, file.id, people.companyhead.token);
    await waitForLock(
      "SELECT count(*)>=2 AS waiting FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE 'SELECT id FROM applications WHERE id=%' AND wait_event_type='Lock'",
    );
    await gate.query("COMMIT");
    const written = await writer,
      read = await reader,
      bytes = await download;
    expect(written.status).toBe(200);
    expect(read.status).toBe(200);
    expect(bytes.status).toBe(200);
    expect((await read.json()).data).toEqual((await written.json()).data);
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(png);
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await Promise.all([writer, reader, download]);
    await database().query("DROP TRIGGER test_pause_purchase ON approval_logs");
    await database().query("DROP FUNCTION test_pause_purchase()");
  }
});

test("采购写接口拒绝查询参数、错误媒体类型、超限正文和非法任务 ID", async () => {
  const value = await pending();
  const ctx = {
    params: Promise.resolve({
      id: value.application.id,
      taskId: value.tasks[0].id,
    }),
  };
  for (const search of ["?version=2", "?x=1&x=2"]) {
    const req = (token: string, body: unknown) =>
      new Request(origin + "/api/purchase-applications/x" + search, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect(
      (
        await purchaseDecisionHandler(
          req(people.head.token, { version: 2, decision: "approve" }),
          ctx,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await purchaseWithdrawalHandler(
          req(people.owner.token, { version: 2 }),
          context(value.application.id),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await purchaseDecisionHandler(
        request(
          "POST",
          { version: 2, decision: "approve" },
          people.head.token,
          { "Content-Type": "text/plain" },
        ),
        ctx,
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await purchaseDecisionHandler(
        request(
          "POST",
          { version: 2, decision: "approve", opinion: "x".repeat(17000) },
          people.head.token,
        ),
        ctx,
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await purchaseDecisionHandler(
        request("POST", { version: 2, decision: "approve" }, people.head.token),
        {
          params: Promise.resolve({
            id: value.application.id,
            taskId: "bad-id",
          }),
        },
      )
    ).status,
  ).toBe(400);
  expect((await (await detail(value.application.id)).json()).data).toEqual(
    value,
  );
});
