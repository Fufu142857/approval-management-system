import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  uploadReimbursementAttachment,
  deleteReimbursementAttachment,
} from "../src/server/reimbursement-attachments";
import {
  submittedReimbursementAttachmentsHandler,
  submittedReimbursementAttachmentContentHandler,
  reimbursementAttachmentsHandler,
} from "../src/server/reimbursement-attachment-handlers";
import { getNotification } from "../src/server/notifications";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { changeUserAccess } from "../src/server/admin";
import {
  createReimbursementDraftHandler,
  replaceReimbursementDraftHandler,
  deleteReimbursementDraftHandler,
  getReimbursementDraftHandler,
} from "../src/server/reimbursement-handlers";
import {
  submitReimbursementHandler,
  reimbursementApplicationHandler,
} from "../src/server/reimbursement-submission-handlers";

const origin = "http://localhost:3000";
const fields = {
  title: "费用报销提交",
  description: "业务费用",
  independentReason: "独立支出说明",
  remarks: "备注",
  items: [
    {
      category: "transport",
      expenseDate: "2028-02-29",
      purpose: "车费",
      amount: "0.10",
      noReceipt: true,
      noReceiptReason: "票据遗失",
    },
    {
      category: "lodging",
      expenseDate: "2028-03-01",
      purpose: "住宿",
      amount: "0.20",
      noReceipt: true,
      noReceiptReason: "小额例外",
    },
    {
      category: "meals",
      expenseDate: "2028-03-01",
      purpose: "餐饮",
      amount: "1.23",
      noReceipt: true,
      noReceiptReason: "明确例外",
    },
  ],
};
const people: Record<string, { id: string; token: string }> = {};
const storage = resolve("tmp/attachments-vitest-test");
let png: Buffer;
let departmentId: string;
let financeDepartmentId: string;
function request(
  method = "GET",
  body?: unknown,
  token = people.owner.token,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/reimbursement-drafts`, {
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
  const response = await createReimbursementDraftHandler(
    request("POST", { ...fields, ...extra }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data;
}
const submit = (id: string, version = 1, token = people.owner.token) =>
  submitReimbursementHandler(request("POST", { version }, token), context(id));
const detail = (id: string, token = people.owner.token) =>
  reimbursementApplicationHandler(
    request("GET", undefined, token),
    context(id),
  );
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
afterAll(async () => {
  await closeDatabase();
  await rm(storage, { recursive: true, force: true });
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
        await submitReimbursementHandler(
          request("POST", { version: 1, ...extra }),
          context(saved.id),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (await submitReimbursementHandler(request("POST", {}), context(saved.id)))
      .status,
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
        ? replaceReimbursementDraftHandler(
            request("PUT", { ...fields, title: "另一个窗口", version: 1 }),
            context(saved.id),
          )
        : deleteReimbursementDraftHandler(
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
    ["approval_instances", "rule_version<>'fixed-reimbursement-v1'"],
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
            await getReimbursementDraftHandler(request(), context(saved.id))
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
        await submitReimbursementHandler(
          request("POST", { version: 1 }, "", headers),
          context(saved.id),
        )
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await submitReimbursementHandler(
        request("POST", { version: 1 }, people.owner.token, {
          "Content-Type": "text/plain",
        }),
        context(saved.id),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await submitReimbursementHandler(
        request("POST", { version: 1 }, "", {
          Cookie: `approval_session=${people.owner.token}`,
          Origin: origin,
        }),
        context(saved.id),
      )
    ).status,
  ).toBe(200);
});

test("三条费用精确合计、无票例外、固定财务路径与提交记录原子冻结", async () => {
  const saved = await draft();
  const response = await submit(saved.id);
  expect(response.status).toBe(200);
  const value = (await response.json()).data;
  expect(value.application).toMatchObject({
    id: saved.id,
    appNo: saved.appNo,
    status: "pending",
    version: 2,
    totalAmount: "1.53",
    noReceiptCount: 3,
    departmentId,
  });
  expect(value.application.items).toEqual(saved.items);
  expect(value.application.submittedAt).toMatch(/^\d{4}-/);
  expect(value.workflow).toMatchObject({
    ruleVersion: "fixed-reimbursement-v1",
    submittedVersion: 2,
    routeSnapshot: {
      totalAmount: "1.53",
      independentReason: fields.independentReason,
      linkedApplications: [],
      attachmentEvidence: [],
      noReceiptItems: saved.items.map(
        (item: { id: string; noReceiptReason: string }) => ({
          id: item.id,
          reason: item.noReceiptReason,
        }),
      ),
      steps: [
        { seqNo: 1, approver: { id: people.head.id } },
        {
          seqNo: 2,
          rule: "finance_approver",
          approver: { id: people.finance.id },
        },
      ],
    },
  });
  expect(value.tasks.map((task: { status: string }) => task.status)).toEqual([
    "pending",
    "blocked",
  ]);
  expect(value.tasks[0].activatedAt).not.toBeNull();
  expect(value.tasks[1].activatedAt).toBeNull();
  expect(value.logs).toHaveLength(1);
  expect(value.logs[0]).toMatchObject({
    action: "submitted",
    result: "pending",
    applicationVersion: 2,
    actorId: people.owner.id,
  });
  expect(await executionCounts()).toEqual({
    instances: 1,
    tasks: 2,
    logs: 1,
    notifications: 1,
  });
  const notice = (
    await database().query("SELECT id,recipient_id FROM notifications")
  ).rows[0];
  expect(notice.recipient_id).toBe(people.head.id);
  expect(await getNotification(people.head.token, notice.id)).toMatchObject({
    target: {
      type: "reimbursement",
      id: saved.id,
      apiPath: `/api/reimbursement-applications/${saved.id}`,
    },
    task: { id: value.tasks[0].id, status: "pending" },
  });
});

test("完整字段、独立说明、每行票据或明确无票原因缺失均拒绝，不能凑空行", async () => {
  for (const extra of [
    { title: "" },
    { description: "" },
    { independentReason: "" },
    { items: [] },
    ...["category", "expenseDate", "amount"].map((key) => ({
      items: [{ ...fields.items[0], [key]: null }],
    })),
    { items: [{ ...fields.items[0], purpose: "" }] },
    { items: [{ ...fields.items[0], noReceipt: false }] },
    { items: [{ ...fields.items[0], noReceiptReason: "" }] },
    { items: [fields.items[0], {}] },
  ]) {
    const saved = await draft(extra);
    const response = await submit(saved.id);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(
      (
        await (
          await getReimbursementDraftHandler(request(), context(saved.id))
        ).json()
      ).data,
    ).toEqual(saved);
  }
  expect(await executionCounts()).toEqual(emptyExecution);
  const single = await draft({ items: [fields.items[0]] });
  expect((await submit(single.id)).status).toBe(200);
});

async function receipt(
  app: { id: string; items: { id: string }[] },
  version = 1,
  index = 0,
  bytes = png,
  name = "票据.png",
  type = "image/png",
) {
  return uploadReimbursementAttachment(
    people.owner.token,
    app.id,
    app.items[index].id,
    version,
    bytes,
    name,
    type,
    "R-001",
  );
}
const fileContext = (id: string, attachmentId?: string) => ({
  params: Promise.resolve({ id, attachmentId }),
});

test("真实JPEG/PNG/PDF多票与无票可以共存，提交后只授权本人和已激活节点且冻结", async () => {
  const app = await draft({
    items: [
      { ...fields.items[0], noReceipt: false },
      fields.items[1],
      fields.items[2],
    ],
  });
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const payloads = [
    [png, "票据.png", "image/png"],
    [await sharp(png).jpeg().toBuffer(), "票据.jpg", "image/jpeg"],
    [Buffer.from(await doc.save()), "票据.pdf", "application/pdf"],
  ] as const;
  const files = [];
  for (const [index, [bytes, name, type]] of payloads.entries())
    files.push(
      (await receipt(app, index + 1, 0, bytes, name, type)).attachment,
    );
  const result = (await (await submit(app.id, 4)).json()).data;
  expect(result.workflow.routeSnapshot.attachmentEvidence).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain("storageKey");
  for (const token of [people.owner.token, people.head.token]) {
    const listed = await submittedReimbursementAttachmentsHandler(
      request("GET", undefined, token),
      fileContext(app.id),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).data).toMatchObject({
      version: 5,
      status: "pending",
      items: files,
    });
    for (const [index, file] of files.entries()) {
      const response = await submittedReimbursementAttachmentContentHandler(
        request("GET", undefined, token),
        fileContext(app.id, file.id),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        payloads[index][0],
      );
    }
  }
  for (const token of [
    people.finance.token,
    people.admin.token,
    people.outsider.token,
  ]) {
    expect(
      (
        await submittedReimbursementAttachmentsHandler(
          request("GET", undefined, token),
          fileContext(app.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await submittedReimbursementAttachmentContentHandler(
          request("GET", undefined, token),
          fileContext(app.id, files[0].id),
        )
      ).status,
    ).toBe(404);
  }
  expect(
    (await reimbursementAttachmentsHandler(request(), fileContext(app.id)))
      .status,
  ).toBe(409);
  expect(
    (await getReimbursementDraftHandler(request(), context(app.id))).status,
  ).toBe(409);
  expect(
    (
      await replaceReimbursementDraftHandler(
        request("PUT", { ...fields, version: 5 }),
        context(app.id),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await deleteReimbursementDraftHandler(
        request("DELETE", { version: 5 }),
        context(app.id),
      )
    ).status,
  ).toBe(409);
  await expect(receipt(app, 5)).rejects.toMatchObject({ status: 409 });
  await expect(
    deleteReimbursementAttachment(people.owner.token, app.id, files[0].id, 5),
  ).rejects.toMatchObject({ status: 409 });
  for (const sql of [
    "UPDATE reimbursement_requests SET description='changed' WHERE app_id=$1",
    "DELETE FROM reimbursement_items WHERE app_id=$1",
    "DELETE FROM attachments WHERE app_id=$1",
  ])
    await expect(database().query(sql, [app.id])).rejects.toMatchObject({
      code: "23514",
    });
  const other = await draft();
  expect(
    (
      await submittedReimbursementAttachmentContentHandler(
        request(),
        fileContext(other.id, files[0].id),
      )
    ).status,
  ).toBe(404);
  await migrate();
  await closeDatabase();
  expect((await (await detail(app.id)).json()).data).toEqual(result);
});

test("其他明细票据不能替代本行票据；无票原因不能只填文字而不选例外", async () => {
  const app = await draft({
    items: fields.items.map((item) => ({ ...item, noReceipt: false })),
  });
  await receipt(app);
  expect((await submit(app.id, 2)).status).toBe(400);
  expect(await executionCounts()).toEqual(emptyExecution);
  await receipt(app, 2, 1);
  await receipt(app, 3, 2);
  expect((await submit(app.id, 4)).status).toBe(200);
});

test("包括无票行附加文件在内的缺失或损坏票据均阻止提交且保留草稿", async () => {
  const app = await draft();
  const file = (await receipt(app)).attachment;
  const key = (
    await database().query("SELECT storage_key FROM attachments WHERE id=$1", [
      file.id,
    ])
  ).rows[0].storage_key;
  const path = join(storage, `${key}.blob`);
  for (const broken of [true, false]) {
    if (broken) await writeFile(path, Buffer.alloc(png.length));
    else await rm(path);
    const response = await submit(app.id, 2);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ATTACHMENT_UNAVAILABLE");
  }
  expect(await executionCounts()).toEqual(emptyExecution);
  await writeFile(path, png);
  expect((await submit(app.id, 2)).status).toBe(200);
});

test("提交与附件上传或删除竞争只允许一个版本写入", async () => {
  for (const operation of ["upload", "delete"]) {
    const app = await draft();
    const file = (await receipt(app)).attachment;
    const [response, mutation] = await Promise.all([
      submit(app.id, 2),
      (operation === "upload"
        ? receipt(app, 2)
        : deleteReimbursementAttachment(people.owner.token, app.id, file.id, 2)
      ).then(
        () => 200,
        (error) => error.status,
      ),
    ]);
    expect([response.status, mutation].sort()).toEqual([200, 409]);
  }
});

test("提交重新检查整单票据数量和总大小，不能用原始数据库异常记录绕过", async () => {
  for (const [count, size] of [
    [10, 1],
    [6, 10485760],
  ]) {
    const app = await draft();
    for (let i = 0; i < count; i++)
      await database().query(
        "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,reimbursement_item_id) VALUES ($1,$2,$3,'fixture.png','image/png',$4,$5,$6)",
        [
          app.id,
          people.owner.id,
          randomUUID(),
          size,
          "0".repeat(64),
          app.items[0].id,
        ],
      );
    const response = await submit(app.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ATTACHMENT_INCONSISTENT");
  }
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("版本上限、未知查询、过大正文以及跨业务端点严格拒绝", async () => {
  const app = await draft();
  await database().query(
    "UPDATE applications SET version=2147483647 WHERE id=$1",
    [app.id],
  );
  expect((await submit(app.id, 2147483647)).status).toBe(409);
  for (const suffix of ["?x=1", "?version=1&version=1"]) {
    expect(
      (
        await submitReimbursementHandler(
          new Request(`${origin}/api/x${suffix}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${people.owner.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ version: 1 }),
          }),
          context(app.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await reimbursementApplicationHandler(
          new Request(`${origin}/api/x${suffix}`, {
            headers: { Authorization: `Bearer ${people.owner.token}` },
          }),
          context(app.id),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await submitReimbursementHandler(
        request("POST", { version: 1, padding: "x".repeat(17000) }),
        context(app.id),
      )
    ).status,
  ).toBe(413);
  const { travelApplicationHandler } =
    await import("../src/server/travel-submission-handlers");
  const { purchaseApplicationHandler } =
    await import("../src/server/purchase-submission-handlers");
  expect(
    (await travelApplicationHandler(request(), context(app.id))).status,
  ).toBe(404);
  expect(
    (await purchaseApplicationHandler(request(), context(app.id))).status,
  ).toBe(404);
  expect(await executionCounts()).toEqual(emptyExecution);
});

test("同一非申请人兼任两节点时仍创建两个有序任务，不提前激活第二步", async () => {
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='finance_approver'",
    [people.finance.id],
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'finance_approver')",
    [people.head.id],
  );
  const app = await draft();
  const result = (await (await submit(app.id)).json()).data;
  expect(
    result.tasks.map((task: { approverId: string }) => task.approverId),
  ).toEqual([people.head.id, people.head.id]);
  expect(result.tasks.map((task: { status: string }) => task.status)).toEqual([
    "pending",
    "blocked",
  ]);
});

async function approvedSource(type: "travel" | "purchase") {
  if (type === "travel") {
    const { travelDraftSchema } = await import("../src/lib/travel");
    const { createTravelDraft } = await import("../src/server/travel");
    const { submitTravelDraft } =
      await import("../src/server/travel-submission");
    const { decideTravelTask } = await import("../src/server/travel-actions");
    const saved = await createTravelDraft(
      people.owner.token,
      travelDraftSchema.parse({
        title: "差旅来源",
        departure: "杭州",
        destination: "上海",
        startDate: "2028-02-28",
        endDate: "2028-03-01",
        purpose: "交流",
        transportation: "高铁",
        budget: "200",
      }),
    );
    let result = await submitTravelDraft(people.owner.token, saved.id, 1);
    result = await decideTravelTask(
      people.head.token,
      saved.id,
      result.tasks[0].id,
      { version: result.application.version, decision: "approve", opinion: "" },
    );
    return (
      await decideTravelTask(
        people.finance.token,
        saved.id,
        result.tasks[1].id,
        {
          version: result.application.version,
          decision: "approve",
          opinion: "",
        },
      )
    ).application;
  }
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'company_head') ON CONFLICT DO NOTHING",
    [people.finance.id],
  );
  const { purchaseDraftSchema } = await import("../src/lib/purchase");
  const { createPurchaseDraft } = await import("../src/server/purchase");
  const { submitPurchaseDraft } =
    await import("../src/server/purchase-submission");
  const { decidePurchaseTask } = await import("../src/server/purchase-actions");
  const saved = await createPurchaseDraft(
    people.owner.token,
    purchaseDraftSchema.parse({
      title: "采购来源",
      reason: "设备",
      expectedDate: "2028-03-01",
      budgetLimit: "100",
      selectionReason: "适配",
      singleSource: true,
      singleSourceReason: "独家",
      items: [
        {
          name: "设备",
          specification: "A",
          quantity: "1",
          unit: "台",
          unitPrice: "50",
        },
      ],
      quotes: [
        {
          supplierName: "甲",
          quoteDate: "2028-02-01",
          amount: "50",
          basis: "书面",
          selected: true,
        },
      ],
    }),
  );
  let result = await submitPurchaseDraft(people.owner.token, saved.id, 1);
  result = await decidePurchaseTask(
    people.head.token,
    saved.id,
    result.tasks[0].id,
    { version: result.application.version, decision: "approve", opinion: "" },
  );
  return (
    await decidePurchaseTask(
      people.finance.token,
      saved.id,
      result.tasks[1].id,
      { version: result.application.version, decision: "approve", opinion: "" },
    )
  ).application;
}

test("关联本人真实已批差旅及采购；新审批人可见冻结摘要但不获得原单权限", async () => {
  const travel = await approvedSource("travel"),
    purchase = await approvedSource("purchase");
  const app = await draft({
    linkedApplicationIds: [travel.id, purchase.id],
    independentReason: "",
  });
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='department_head'",
    [people.head.id],
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'department_head')",
    [people.outsider.id],
  );
  const before = (
    await database().query(
      "SELECT id,title,version,updated_at FROM applications WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[travel.id, purchase.id]],
    )
  ).rows;
  const response = await submit(app.id);
  expect(response.status).toBe(200);
  const result = (await response.json()).data;
  expect(result.application.linkedApplications).toEqual(app.linkedApplications);
  expect(result.workflow.routeSnapshot.linkedApplications).toEqual(
    app.linkedApplications,
  );
  expect(
    result.application.linkedApplications.find(
      (link: { type: string }) => link.type === "travel",
    ).travel.destination,
  ).toBe("上海");
  expect((await detail(app.id, people.outsider.token)).status).toBe(200);
  const { travelApplicationHandler } =
    await import("../src/server/travel-submission-handlers");
  const { purchaseApplicationHandler } =
    await import("../src/server/purchase-submission-handlers");
  expect(
    (
      await travelApplicationHandler(
        request("GET", undefined, people.outsider.token),
        context(travel.id),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await purchaseApplicationHandler(
        request("GET", undefined, people.outsider.token),
        context(purchase.id),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await database().query(
        "SELECT id,title,version,updated_at FROM applications WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[travel.id, purchase.id]],
      )
    ).rows,
  ).toEqual(before);
  // An out-of-band source mutation cannot alter a submitted reimbursement's frozen summary.
  await database().query(
    "UPDATE applications SET title='later source title',applicant_id=$2 WHERE id=$1",
    [travel.id, people.finance.id],
  );
  expect((await (await detail(app.id)).json()).data).toEqual(result);
  expect(
    (await (await detail(app.id, people.outsider.token)).json()).data,
  ).toEqual(result);
  await expect(
    database().query("DELETE FROM application_links WHERE target_app_id=$1", [
      app.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
});

test("提交时重核来源所有权和已批状态，失败不生成报销执行记录", async () => {
  const source = await approvedSource("travel");
  const app = await draft({
    linkedApplicationIds: [source.id],
    independentReason: "",
  });
  const before = await executionCounts();
  for (const sql of [
    "UPDATE applications SET applicant_id=$2 WHERE id=$1",
    "UPDATE applications SET status='rejected' WHERE id=$1",
  ]) {
    await database().query(
      sql,
      sql.includes("$2") ? [source.id, people.outsider.id] : [source.id],
    );
    const response = await submit(app.id);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("LINK_NOT_AVAILABLE");
    expect(await executionCounts()).toEqual(before);
    expect(
      (
        await database().query(
          "SELECT status,version,submitted_at FROM applications WHERE id=$1",
          [app.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "draft", version: 1, submitted_at: null });
    await database().query(
      "UPDATE applications SET applicant_id=$2,status='approved' WHERE id=$1",
      [source.id, people.owner.id],
    );
  }
  expect((await submit(app.id)).status).toBe(200);
});

test("详情与票据等待申请锁后重新授权，不泄露已失去激活记录的节点", async () => {
  const app = await draft();
  const file = (await receipt(app)).attachment;
  const result = (await (await submit(app.id, 2)).json()).data;
  const client = await database().connect();
  let reads: Promise<Response[]> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM applications WHERE id=$1 FOR UPDATE", [
      app.id,
    ]);
    reads = Promise.all([
      detail(app.id, people.head.token),
      submittedReimbursementAttachmentContentHandler(
        request("GET", undefined, people.head.token),
        fileContext(app.id, file.id),
      ),
    ]);
    let completed = false;
    void reads.then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(completed).toBe(false);
    // Raw fixture exercises the post-lock authorization boundary; no action endpoint is implemented here.
    await client.query(
      "UPDATE approval_tasks SET status='cancelled',activated_at=NULL,finished_at=now() WHERE id=$1",
      [result.tasks[0].id],
    );
    await client.query("COMMIT");
    expect((await reads).map((response) => response.status)).toEqual([
      404, 404,
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await reads;
  }
});
