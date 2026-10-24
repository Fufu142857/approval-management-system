import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { reimbursementFields } from "../src/lib/reimbursement-display";
import { beforeAll, beforeEach, afterAll, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  reimbursementDraftSchema,
  replaceReimbursementDraftSchema,
} from "../src/lib/reimbursement";
import {
  createReimbursementDraft,
  getReimbursementDraft,
  replaceReimbursementDraft,
  deleteReimbursementDraft,
} from "../src/server/reimbursement";
import {
  submitReimbursementDraft,
  getReimbursementApplication,
} from "../src/server/reimbursement-submission";
import {
  decideReimbursementTask,
  withdrawReimbursementApplication,
} from "../src/server/reimbursement-actions";
import {
  copyReimbursementForResubmission,
  getReimbursementResubmission,
} from "../src/server/reimbursement-resubmission";
import {
  copyReimbursementHandler,
  reimbursementResubmissionHandler,
} from "../src/server/reimbursement-resubmission-handlers";
import {
  uploadReimbursementAttachment,
  listReimbursementAttachments,
  listSubmittedReimbursementAttachments,
  getSubmittedReimbursementAttachmentContent,
} from "../src/server/reimbursement-attachments";

const people: Record<string, { id: string; token: string }> = {};
const fields = reimbursementDraftSchema.parse({
  title: "报销重提测试",
  description: "项目费用",
  independentReason: "独立临时支出",
  remarks: "完整备注",
  items: [
    {
      category: "transport",
      expenseDate: "2028-02-29",
      purpose: "交通",
      amount: "0.10",
      noReceipt: true,
      noReceiptReason: "未提供票据",
    },
    {
      category: "meals",
      expenseDate: "2028-03-01",
      purpose: "餐费",
      amount: "0.20",
      noReceipt: true,
      noReceiptReason: "票据遗失",
    },
  ],
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const owner = () => people.owner.token;
function req(
  method = "GET",
  body?: unknown,
  token = owner(),
  search = "",
  extra: Record<string, string> = {},
) {
  return new Request(
    `http://localhost:3000/api/reimbursement-applications/test/resubmission${search}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
async function session(id: string) {
  const token = randomBytes(32).toString("hex");
  await database().query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
    [tokenHash(token), id],
  );
  return token;
}
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = "http://localhost:3000";
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await seedOrganization("Resubmission-test-password");
  const admin = (
    await database().query(
      "SELECT id,department_id FROM users WHERE username='admin'",
    )
  ).rows[0];
  people.admin = { id: admin.id, token: await session(admin.id) };
  for (const username of ["owner", "head", "finance", "other", "pending"]) {
    const id = (
      await database().query(
        `INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
      SELECT $1::text,$1::text,$1::text||'@example.invalid',password_hash,department_id,department_id,
      CASE WHEN $1::text='pending' THEN 'pending' ELSE 'active' END FROM users WHERE username='admin' RETURNING id`,
        [username],
      )
    ).rows[0].id;
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
      [id],
    );
    if (["head", "finance"].includes(username))
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, username === "head" ? "department_head" : "finance_approver"],
      );
    people[username] = { id, token: await session(id) };
  }
});
afterAll(closeDatabase);
async function pending(withAttachment = false) {
  const draft = await createReimbursementDraft(owner(), fields);
  let version = draft.version;
  if (withAttachment) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const file = await uploadReimbursementAttachment(
      owner(),
      draft.id,
      draft.items[0].id,
      version,
      bytes,
      "原报价.png",
      "image/png",
    );
    version = file.version;
  }
  return submitReimbursementDraft(owner(), draft.id, version);
}
async function terminal(
  status: "rejected" | "withdrawn" = "withdrawn",
  withAttachment = false,
) {
  const value = await pending(withAttachment);
  return status === "withdrawn"
    ? withdrawReimbursementApplication(owner(), value.application.id, {
        version: value.application.version,
        opinion: "取消",
      })
    : decideReimbursementTask(
        people.head.token,
        value.application.id,
        value.tasks[0].id,
        {
          version: value.application.version,
          decision: "reject",
          opinion: "需要修改",
        },
      );
}
const copy = (value: Awaited<ReturnType<typeof terminal>>) =>
  copyReimbursementForResubmission(
    owner(),
    value.application.id,
    value.application.version,
  );
async function counts() {
  return (
    await database().query(
      `SELECT (SELECT count(*)::int FROM applications) AS apps,(SELECT count(*)::int FROM approval_instances) AS instances,(SELECT count(*)::int FROM approval_tasks) AS tasks,(SELECT count(*)::int FROM approval_logs) AS logs,(SELECT count(*)::int FROM notifications) AS notices`,
    )
  ).rows[0];
}

test("复制完整字段与精确金额，重置编号/版本/提交信息，原历史与附件原字节保留", async () => {
  const original = await terminal("withdrawn", true);
  const before = await counts();
  const files = await listSubmittedReimbursementAttachments(
    owner(),
    original.application.id,
  );
  const bytes = await getSubmittedReimbursementAttachmentContent(
    owner(),
    original.application.id,
    files.items[0].id,
  );
  const result = await copy(original);
  expect(result.created).toBe(true);
  expect(result.successor.id).not.toBe(original.application.id);
  expect(result.successor.appNo).not.toBe(original.application.appNo);
  const draft = await getReimbursementDraft(owner(), result.successor.id);
  expect(draft).toMatchObject({
    ...fields,
    totalAmount: "0.30",
    version: 1,
    status: "draft",
    submittedAt: null,
    resubmissionOf: original.application.id,
  });
  for (const key of ["items"] as const) {
    expect(
      draft[key].map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")),
      ),
    ).toEqual(
      original.application[key].map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")),
      ),
    );
    expect(
      draft[key].every(
        (row) => !original.application[key].some((old) => old.id === row.id),
      ),
    ).toBe(true);
  }
  expect((await listReimbursementAttachments(owner(), draft.id)).items).toEqual(
    [],
  );
  expect(
    await getReimbursementApplication(owner(), original.application.id),
  ).toEqual(original);
  expect(
    await getSubmittedReimbursementAttachmentContent(
      owner(),
      original.application.id,
      files.items[0].id,
    ),
  ).toEqual(bytes);
  expect(await counts()).toEqual({ ...before, apps: before.apps + 1 });
});

test("驳回后修改重提生成新实例、任务和通知，不继承决定或改动原记录", async () => {
  const original = await terminal("rejected");
  const { successor } = await copy(original);
  const draft = await replaceReimbursementDraft(
    owner(),
    successor.id,
    replaceReimbursementDraftSchema.parse({
      ...fields,
      items: reimbursementFields(
        await getReimbursementDraft(owner(), successor.id),
      ).items,
      title: "修改后报销",
      description: "修改后的说明",
      version: 1,
    }),
  );
  const next = await submitReimbursementDraft(owner(), draft.id, draft.version);
  expect(next.application).toMatchObject({
    items: draft.items,
    title: "修改后报销",
    description: "修改后的说明",
    resubmissionOf: original.application.id,
    status: "pending",
  });
  expect(next.workflow.id).not.toBe(original.workflow.id);
  expect(next.tasks.map((task) => task.status)).toEqual(["pending", "blocked"]);
  expect(next.logs).toHaveLength(1);
  expect(
    await getReimbursementApplication(owner(), original.application.id),
  ).toEqual(original);
  expect((await copy(original)).successor).toMatchObject({
    id: next.application.id,
    version: next.application.version,
    status: "pending",
  });
});

test.each(["draft", "pending", "approved"])(
  "%s 状态拒绝复制且无额外写入",
  async (state) => {
    let app =
      state === "draft"
        ? await createReimbursementDraft(owner(), fields)
        : (await pending()).application;
    if (state === "approved") {
      let value = await getReimbursementApplication(owner(), app.id);
      value = await decideReimbursementTask(
        people.head.token,
        app.id,
        value.tasks[0].id,
        {
          version: value.application.version,
          decision: "approve",
          opinion: "",
        },
      );
      app = (
        await decideReimbursementTask(
          people.finance.token,
          app.id,
          value.tasks[1].id,
          {
            version: value.application.version,
            decision: "approve",
            opinion: "",
          },
        )
      ).application;
    }
    const before = await counts();
    expect(
      (
        await copyReimbursementHandler(
          req("POST", { version: app.version }),
          ctx(app.id),
        )
      ).status,
    ).toBe(409);
    expect(
      (await reimbursementResubmissionHandler(req(), ctx(app.id))).status,
    ).toBe(409);
    expect(await counts()).toEqual(before);
  },
);

test("所有权独立校验：管理员、历史审批人、其他员工不能查看后续或复制，身份失效拒绝", async () => {
  const original = await terminal("rejected");
  for (const name of ["admin", "head", "other", "pending"]) {
    const code = name === "pending" ? 403 : 404;
    expect(
      (
        await copyReimbursementHandler(
          req(
            "POST",
            { version: original.application.version },
            people[name].token,
          ),
          ctx(original.application.id),
        )
      ).status,
    ).toBe(code);
    expect(
      (
        await reimbursementResubmissionHandler(
          req("GET", undefined, people[name].token),
          ctx(original.application.id),
        )
      ).status,
    ).toBe(code);
  }
  expect(
    (
      await copyReimbursementHandler(
        req("POST", { version: original.application.version }, "", "", {
          Origin: "http://localhost:3000",
        }),
        ctx(original.application.id),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await copyReimbursementHandler(
        req("POST", { version: 1 }),
        ctx(randomUUID()),
      )
    ).status,
  ).toBe(404);
});

test("严格参数与 Cookie 来源校验，拒绝伪造来源/身份/字段和查询参数", async () => {
  const value = await terminal();
  const id = value.application.id;
  const version = value.application.version;
  for (const body of [
    {},
    { version: "3" },
    { version: 0 },
    { version, resubmissionOf: randomUUID() },
    { version, applicantId: people.other.id },
    { version, title: "伪造" },
  ])
    expect(
      (await copyReimbursementHandler(req("POST", body), ctx(id))).status,
    ).toBe(400);
  expect(
    (
      await copyReimbursementHandler(
        req("POST", { version }, owner(), "?x=1"),
        ctx(id),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await reimbursementResubmissionHandler(
        req("GET", undefined, owner(), "?x=1&x=2"),
        ctx(id),
      )
    ).status,
  ).toBe(400);
  expect(
    (await copyReimbursementHandler(req("POST", { version }), ctx("bad-id")))
      .status,
  ).toBe(400);
  expect(
    (
      await copyReimbursementHandler(
        req("POST", { version }, "", "", {
          Cookie: `approval_session=${owner()}`,
        }),
        ctx(id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await copyReimbursementHandler(
        req("POST", { version }, owner(), "", {
          Origin: "https://other.invalid",
        }),
        ctx(id),
      )
    ).status,
  ).toBe(403);
  expect(
    (await getReimbursementResubmission(owner(), id)).successor,
  ).toBeNull();
});

test("原版本不匹配拒绝，已有后续草稿也不能绕过版本校验", async () => {
  const value = await terminal();
  for (const withChild of [false, true]) {
    if (withChild) await copy(value);
    const response = await copyReimbursementHandler(
      req("POST", { version: value.application.version - 1 }),
      ctx(value.application.id),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("VERSION_CONFLICT");
  }
});

test("并发和重复复制只有一个新草稿，重复请求不覆盖用户已修改内容", async () => {
  const value = await terminal();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      copyReimbursementHandler(
        req("POST", { version: value.application.version }),
        ctx(value.application.id),
      ),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([
    200, 200, 200, 200, 201,
  ]);
  const results = await Promise.all(
    responses.map(async (r) => (await r.json()).data),
  );
  expect(new Set(results.map((r) => r.successor.id)).size).toBe(1);
  const id = results[0].successor.id;
  await replaceReimbursementDraft(
    owner(),
    id,
    replaceReimbursementDraftSchema.parse({
      ...fields,
      title: "用户修改",
      version: 1,
    }),
  );
  expect((await copy(value)).successor).toMatchObject({ id, version: 2 });
  expect((await getReimbursementDraft(owner(), id)).title).toBe("用户修改");
});

test("删除未提交后续草稿可重建，再次终态沿链重提不覆盖旧链", async () => {
  const value = await terminal();
  const first = await copy(value);
  await deleteReimbursementDraft(owner(), first.successor.id, 1);
  expect(
    (await getReimbursementResubmission(owner(), value.application.id))
      .successor,
  ).toBeNull();
  const second = await copy(value);
  expect(second.successor.id).not.toBe(first.successor.id);
  const sent = await submitReimbursementDraft(owner(), second.successor.id, 1);
  const cancelled = await withdrawReimbursementApplication(
    owner(),
    sent.application.id,
    { version: sent.application.version, opinion: "" },
  );
  const third = await copy(cancelled);
  expect(
    (await getReimbursementDraft(owner(), third.successor.id)).resubmissionOf,
  ).toBe(second.successor.id);
  expect((await copy(value)).successor.id).toBe(second.successor.id);
  expect(
    await getReimbursementApplication(owner(), value.application.id),
  ).toEqual(value);
});

test("关联不能改写，自引用、跨人、非终态来源与重复后续被数据库拒绝", async () => {
  const original = await terminal();
  const child = (await copy(original)).successor;
  await expect(
    database().query(
      "UPDATE applications SET resubmission_of=NULL WHERE id=$1",
      [child.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("UPDATE applications SET applicant_id=$2 WHERE id=$1", [
      child.id,
      people.other.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  const insert = (source: string, person = people.owner.id) =>
    database().query(
      "INSERT INTO applications(type,applicant_id,department_id,resubmission_of) SELECT 'reimbursement',$1,department_id,$2 FROM users WHERE id=$1",
      [person, source],
    );
  await expect(insert(original.application.id)).rejects.toMatchObject({
    code: "23505",
  });
  await expect(
    insert(original.application.id, people.other.id),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(insert(child.id)).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("UPDATE applications SET resubmission_of=id WHERE id=$1", [
      child.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("DELETE FROM applications WHERE id=$1", [
      original.application.id,
    ]),
  ).rejects.toMatchObject({ code: "23503" });
});

test.each(["reimbursement_requests", "reimbursement_items"])(
  "%s 插入故障回滚新主表与全部明细，原业务记录不变",
  async (table) => {
    const value = await terminal();
    const before = await counts();
    await database().query(
      `CREATE FUNCTION fail_resubmission_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_resubmission_test BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_resubmission_test()`,
    );
    try {
      await expect(copy(value)).rejects.toThrow();
    } finally {
      await database().query(
        `DROP TRIGGER fail_resubmission_test ON ${table}; DROP FUNCTION fail_resubmission_test()`,
      );
    }
    expect(await counts()).toEqual(before);
    expect(
      (await getReimbursementResubmission(owner(), value.application.id))
        .successor,
    ).toBeNull();
    expect(
      await getReimbursementApplication(owner(), value.application.id),
    ).toEqual(value);
  },
);

test("新草稿采用当前部门，再次提交重新解析审批人，旧快照保留", async () => {
  const value = await terminal("rejected");
  const department = (
    await database().query("SELECT id FROM departments WHERE name='财务部'")
  ).rows[0].id;
  await database().query("UPDATE users SET department_id=$2 WHERE id=$1", [
    people.owner.id,
    department,
  ]);
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'department_head')",
    [people.other.id],
  );
  await database().query("UPDATE users SET department_id=$2 WHERE id=$1", [
    people.other.id,
    department,
  ]);
  const child = (await copy(value)).successor;
  expect((await getReimbursementDraft(owner(), child.id)).departmentId).toBe(
    department,
  );
  const sent = await submitReimbursementDraft(owner(), child.id, 1);
  expect(sent.tasks[0].approverId).toBe(people.other.id);
  await expect(
    getReimbursementApplication(people.head.token, child.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    getReimbursementApplication(people.other.token, value.application.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    await getReimbursementApplication(owner(), value.application.id),
  ).toEqual(value);
});

test("重复迁移与连接重建保留来源及后续链接", async () => {
  const value = await terminal();
  await copy(value);
  const before = await getReimbursementResubmission(
    owner(),
    value.application.id,
  );
  await migrate();
  await closeDatabase();
  expect(
    await getReimbursementResubmission(owner(), value.application.id),
  ).toEqual(before);
});

test("报销和差旅来源不能混用，新增来源字段不能由普通草稿写入", async () => {
  const original = await terminal();
  const { copyTravelForResubmission } =
    await import("../src/server/travel-resubmission");
  await expect(
    copyTravelForResubmission(
      owner(),
      original.application.id,
      original.application.version,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    database().query(
      "INSERT INTO applications(type,applicant_id,department_id,resubmission_of) SELECT 'travel',applicant_id,department_id,id FROM applications WHERE id=$1",
      [original.application.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(
    reimbursementDraftSchema.safeParse({
      ...fields,
      resubmissionOf: original.application.id,
    }).success,
  ).toBe(false);
  expect(
    replaceReimbursementDraftSchema.safeParse({
      ...fields,
      version: 1,
      resubmissionOf: original.application.id,
    }).success,
  ).toBe(false);
});

async function approvedLinks() {
  const { createTravelDraft } = await import("../src/server/travel");
  const { travelDraftSchema } = await import("../src/lib/travel");
  const { submitTravelDraft } = await import("../src/server/travel-submission");
  const { decideTravelTask } = await import("../src/server/travel-actions");
  const draft = await createTravelDraft(
    owner(),
    travelDraftSchema.parse({
      title: "已批来源",
      purpose: "会议",
      departure: "杭州",
      destination: "上海",
      startDate: "2028-02-29",
      endDate: "2028-03-01",
      transportation: "高铁",
      budget: "10.00",
    }),
  );
  let travel = await submitTravelDraft(owner(), draft.id, draft.version);
  travel = await decideTravelTask(
    people.head.token,
    draft.id,
    travel.tasks[0].id,
    { version: travel.application.version, decision: "approve", opinion: "" },
  );
  travel = await decideTravelTask(
    people.finance.token,
    draft.id,
    travel.tasks[1].id,
    { version: travel.application.version, decision: "approve", opinion: "" },
  );
  const { createPurchaseDraft } = await import("../src/server/purchase");
  const { purchaseDraftSchema } = await import("../src/lib/purchase");
  const { submitPurchaseDraft } =
    await import("../src/server/purchase-submission");
  const { decidePurchaseTask } = await import("../src/server/purchase-actions");
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'company_head')",
    [people.finance.id],
  );
  const purchaseDraft = await createPurchaseDraft(
    owner(),
    purchaseDraftSchema.parse({
      title: "已批采购来源",
      reason: "设备",
      expectedDate: "2028-03-01",
      budgetLimit: "10",
      singleSource: true,
      singleSourceReason: "独家兼容",
      selectionReason: "兼容现有设备",
      items: [
        {
          name: "设备",
          specification: "A1",
          quantity: "1",
          unit: "件",
          unitPrice: "1",
        },
      ],
      quotes: [
        {
          supplierName: "供应商",
          basis: "书面报价",
          quoteDate: "2028-02-29",
          amount: "1",
          selected: true,
        },
      ],
    }),
  );
  let purchase = await submitPurchaseDraft(
    owner(),
    purchaseDraft.id,
    purchaseDraft.version,
  );
  purchase = await decidePurchaseTask(
    people.head.token,
    purchaseDraft.id,
    purchase.tasks[0].id,
    { version: purchase.application.version, decision: "approve", opinion: "" },
  );
  purchase = await decidePurchaseTask(
    people.finance.token,
    purchaseDraft.id,
    purchase.tasks[1].id,
    { version: purchase.application.version, decision: "approve", opinion: "" },
  );
  return { travel, purchase };
}
async function linkedTerminal() {
  const links = await approvedLinks();
  const draft = await createReimbursementDraft(
    owner(),
    reimbursementDraftSchema.parse({
      ...fields,
      independentReason: "",
      linkedApplicationIds: [
        links.travel.application.id,
        links.purchase.application.id,
      ],
    }),
  );
  const sent = await submitReimbursementDraft(owner(), draft.id, draft.version);
  const original = await withdrawReimbursementApplication(owner(), draft.id, {
    version: sent.application.version,
    opinion: "",
  });
  return { links, original };
}

test("有效采购与差旅关联随复制保留，原来源和冻结摘要不变，新提交重新冻结", async () => {
  const { links, original } = await linkedTerminal();
  const child = (await copy(original)).successor;
  const draft = await getReimbursementDraft(owner(), child.id);
  expect(draft.linkedApplicationIds).toEqual(
    original.application.linkedApplicationIds,
  );
  expect(draft.linkedApplications).toEqual(
    original.application.linkedApplications,
  );
  const next = await submitReimbursementDraft(owner(), child.id, child.version);
  expect(next.workflow.routeSnapshot.linkedApplications).toEqual(
    original.workflow.routeSnapshot.linkedApplications,
  );
  expect(next.workflow.id).not.toBe(original.workflow.id);
  expect(
    await getReimbursementApplication(owner(), original.application.id),
  ).toEqual(original);
  const { getTravelApplication } =
    await import("../src/server/travel-submission");
  const { getPurchaseApplication } =
    await import("../src/server/purchase-submission");
  expect(
    await getTravelApplication(owner(), links.travel.application.id),
  ).toEqual(links.travel);
  expect(
    await getPurchaseApplication(owner(), links.purchase.application.id),
  ).toEqual(links.purchase);
});

test.each(["owner", "status"])(
  "复制重验关联%s；不合格时整次回滚，仍可读原冻结详情",
  async (change) => {
    const { links, original } = await linkedTerminal();
    const before = await counts();
    // Test-only database mutation models a source that no longer meets link eligibility.
    await database().query(
      change === "owner"
        ? "UPDATE applications SET applicant_id=$2 WHERE id=$1"
        : "UPDATE applications SET status=$2 WHERE id=$1",
      [
        links.travel.application.id,
        change === "owner" ? people.other.id : "withdrawn",
      ],
    );
    await expect(copy(original)).rejects.toMatchObject({
      status: 404,
      code: "LINK_NOT_AVAILABLE",
    });
    expect(await counts()).toEqual(before);
    expect(
      (await getReimbursementResubmission(owner(), original.application.id))
        .successor,
    ).toBeNull();
    expect(
      await getReimbursementApplication(owner(), original.application.id),
    ).toEqual(original);
  },
);

test("关联写入故障回滚所有复制记录", async () => {
  const { original } = await linkedTerminal();
  const before = await counts();
  await database().query(
    "CREATE FUNCTION fail_reimbursement_copy_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_reimbursement_copy_test BEFORE INSERT ON application_links FOR EACH ROW EXECUTE FUNCTION fail_reimbursement_copy_test()",
  );
  try {
    await expect(copy(original)).rejects.toThrow();
  } finally {
    await database().query(
      "DROP TRIGGER fail_reimbursement_copy_test ON application_links; DROP FUNCTION fail_reimbursement_copy_test()",
    );
  }
  expect(await counts()).toEqual(before);
  expect(
    (await getReimbursementResubmission(owner(), original.application.id))
      .successor,
  ).toBeNull();
  expect(
    await getReimbursementApplication(owner(), original.application.id),
  ).toEqual(original);
});

test("票据及号码不复制，真实新票据绑定新费用；无票标记和原字节保持", async () => {
  const input = reimbursementDraftSchema.parse({
    ...fields,
    items: fields.items.map((item, index) => ({
      ...item,
      noReceipt: index !== 0,
    })),
  });
  const draft = await createReimbursementDraft(owner(), input);
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const upload = await uploadReimbursementAttachment(
    owner(),
    draft.id,
    draft.items[0].id,
    draft.version,
    png,
    "原票据.png",
    "image/png",
    "R-OLD",
  );
  const sent = await submitReimbursementDraft(
    owner(),
    draft.id,
    upload.version,
  );
  const original = await withdrawReimbursementApplication(owner(), draft.id, {
    version: sent.application.version,
    opinion: "",
  });
  const child = (await copy(original)).successor;
  const saved = await getReimbursementDraft(owner(), child.id);
  expect(saved.items.map((item) => item.noReceipt)).toEqual([false, true]);
  expect(saved.noReceiptCount).toBe(1);
  expect((await listReimbursementAttachments(owner(), child.id)).items).toEqual(
    [],
  );
  const before = await counts();
  await expect(
    submitReimbursementDraft(owner(), child.id, 1),
  ).rejects.toMatchObject({ name: "ZodError" });
  expect(await counts()).toEqual(before);
  await expect(
    uploadReimbursementAttachment(
      owner(),
      child.id,
      draft.items[0].id,
      1,
      png,
      "跨行.png",
      "image/png",
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    replaceReimbursementDraft(
      owner(),
      child.id,
      replaceReimbursementDraftSchema.parse({
        ...input,
        items: draft.items,
        version: 1,
      }),
    ),
  ).rejects.toMatchObject({ status: 400, code: "INVALID_ROW_ID" });
  const receipt = await uploadReimbursementAttachment(
    owner(),
    child.id,
    saved.items[0].id,
    1,
    png,
    "新票据.png",
    "image/png",
    "R-NEW",
  );
  const next = await submitReimbursementDraft(
    owner(),
    child.id,
    receipt.version,
  );
  expect(next.workflow.routeSnapshot.attachmentEvidence[0]).toMatchObject({
    id: receipt.attachment.id,
    itemId: saved.items[0].id,
    receiptNumber: "R-NEW",
  });
  expect(next.workflow.routeSnapshot.noReceiptItems[0].id).toBe(
    saved.items[1].id,
  );
  expect(
    await getReimbursementApplication(owner(), original.application.id),
  ).toEqual(original);
  expect(
    (
      await getSubmittedReimbursementAttachmentContent(
        owner(),
        draft.id,
        upload.attachment.id,
      )
    ).bytes,
  ).toEqual(png);
});

test("等待组织锁后重新检查失效会话，不创建后续", async () => {
  const original = await terminal();
  const before = await counts();
  const connection = await database().connect();
  let result: Promise<unknown> | undefined;
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(72002)");
    result = copy(original).then(
      () => "unexpected success",
      (error) => error,
    );
    await expect
      .poll(
        async () =>
          (
            await database().query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=72002 AND NOT granted",
            )
          ).rows[0].count,
      )
      .toBeGreaterThan(0);
    await connection.query("DELETE FROM sessions WHERE user_id=$1", [
      people.owner.id,
    ]);
    await connection.query("COMMIT");
    expect(await result).toMatchObject({ status: 401 });
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
    await result;
  }
  expect(await counts()).toEqual(before);
});
