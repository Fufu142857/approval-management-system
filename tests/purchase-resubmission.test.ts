import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { purchaseFields } from "../src/lib/purchase-display";
import { beforeAll, beforeEach, afterAll, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  purchaseDraftSchema,
  replacePurchaseDraftSchema,
} from "../src/lib/purchase";
import {
  createPurchaseDraft,
  getPurchaseDraft,
  replacePurchaseDraft,
  deletePurchaseDraft,
} from "../src/server/purchase";
import {
  submitPurchaseDraft,
  getPurchaseApplication,
} from "../src/server/purchase-submission";
import {
  decidePurchaseTask,
  withdrawPurchaseApplication,
} from "../src/server/purchase-actions";
import {
  copyPurchaseForResubmission,
  getPurchaseResubmission,
} from "../src/server/purchase-resubmission";
import {
  copyPurchaseHandler,
  purchaseResubmissionHandler,
} from "../src/server/purchase-resubmission-handlers";
import {
  uploadPurchaseAttachment,
  listPurchaseAttachments,
  listSubmittedPurchaseAttachments,
  getSubmittedPurchaseAttachmentContent,
} from "../src/server/purchase-attachments";

const people: Record<string, { id: string; token: string }> = {};
const fields = purchaseDraftSchema.parse({
  title: "采购重提测试",
  reason: "设备更新",
  expectedDate: "2028-03-01",
  project: "研发项目",
  budgetLimit: "123.45",
  selectionReason: "交货及时",
  singleSource: false,
  remarks: "完整备注",
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
    `http://localhost:3000/api/purchase-applications/test/resubmission${search}`,
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
  for (const username of ["owner", "head", "company", "other", "pending"]) {
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
    if (["head", "company"].includes(username))
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, username === "head" ? "department_head" : "company_head"],
      );
    people[username] = { id, token: await session(id) };
  }
});
afterAll(closeDatabase);
async function pending(withAttachment = false) {
  const draft = await createPurchaseDraft(owner(), fields);
  let version = draft.version;
  if (withAttachment) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const file = await uploadPurchaseAttachment(
      owner(),
      draft.id,
      draft.quotes[0].id,
      version,
      bytes,
      "原报价.png",
      "image/png",
    );
    version = file.version;
  }
  return submitPurchaseDraft(owner(), draft.id, version);
}
async function terminal(
  status: "rejected" | "withdrawn" = "withdrawn",
  withAttachment = false,
) {
  const value = await pending(withAttachment);
  return status === "withdrawn"
    ? withdrawPurchaseApplication(owner(), value.application.id, {
        version: value.application.version,
        opinion: "取消",
      })
    : decidePurchaseTask(
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
  copyPurchaseForResubmission(
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

test("复制完整字段与精确预算，重置编号/版本/提交信息，原历史与附件原字节保留", async () => {
  const original = await terminal("withdrawn", true);
  const before = await counts();
  const files = await listSubmittedPurchaseAttachments(
    owner(),
    original.application.id,
  );
  const bytes = await getSubmittedPurchaseAttachmentContent(
    owner(),
    original.application.id,
    files.items[0].id,
  );
  const result = await copy(original);
  expect(result.created).toBe(true);
  expect(result.successor.id).not.toBe(original.application.id);
  expect(result.successor.appNo).not.toBe(original.application.appNo);
  const draft = await getPurchaseDraft(owner(), result.successor.id);
  expect(draft).toMatchObject({
    ...fields,
    totalAmount: "0.80",
    version: 1,
    status: "draft",
    submittedAt: null,
    resubmissionOf: original.application.id,
  });
  for (const key of ["items", "quotes"] as const) {
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
  expect((await listPurchaseAttachments(owner(), draft.id)).items).toEqual([]);
  expect(
    await getPurchaseApplication(owner(), original.application.id),
  ).toEqual(original);
  expect(
    await getSubmittedPurchaseAttachmentContent(
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
  const draft = await replacePurchaseDraft(
    owner(),
    successor.id,
    replacePurchaseDraftSchema.parse({
      ...fields,
      items: purchaseFields(await getPurchaseDraft(owner(), successor.id))
        .items,
      quotes: (await getPurchaseDraft(owner(), successor.id)).quotes,
      title: "修改后采购",
      budgetLimit: "234.56",
      version: 1,
    }),
  );
  const next = await submitPurchaseDraft(owner(), draft.id, draft.version);
  expect(next.application).toMatchObject({
    items: draft.items,
    quotes: draft.quotes,
    title: "修改后采购",
    budgetLimit: "234.56",
    resubmissionOf: original.application.id,
    status: "pending",
  });
  expect(next.workflow.id).not.toBe(original.workflow.id);
  expect(next.tasks.map((task) => task.status)).toEqual(["pending", "blocked"]);
  expect(next.logs).toHaveLength(1);
  expect(
    await getPurchaseApplication(owner(), original.application.id),
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
        ? await createPurchaseDraft(owner(), fields)
        : (await pending()).application;
    if (state === "approved") {
      let value = await getPurchaseApplication(owner(), app.id);
      value = await decidePurchaseTask(
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
        await decidePurchaseTask(
          people.company.token,
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
        await copyPurchaseHandler(
          req("POST", { version: app.version }),
          ctx(app.id),
        )
      ).status,
    ).toBe(409);
    expect((await purchaseResubmissionHandler(req(), ctx(app.id))).status).toBe(
      409,
    );
    expect(await counts()).toEqual(before);
  },
);

test("所有权独立校验：管理员、历史审批人、其他员工不能查看后续或复制，身份失效拒绝", async () => {
  const original = await terminal("rejected");
  for (const name of ["admin", "head", "other", "pending"]) {
    const code = name === "pending" ? 403 : 404;
    expect(
      (
        await copyPurchaseHandler(
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
        await purchaseResubmissionHandler(
          req("GET", undefined, people[name].token),
          ctx(original.application.id),
        )
      ).status,
    ).toBe(code);
  }
  expect(
    (
      await copyPurchaseHandler(
        req("POST", { version: original.application.version }, "", "", {
          Origin: "http://localhost:3000",
        }),
        ctx(original.application.id),
      )
    ).status,
  ).toBe(401);
  expect(
    (await copyPurchaseHandler(req("POST", { version: 1 }), ctx(randomUUID())))
      .status,
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
    expect((await copyPurchaseHandler(req("POST", body), ctx(id))).status).toBe(
      400,
    );
  expect(
    (
      await copyPurchaseHandler(
        req("POST", { version }, owner(), "?x=1"),
        ctx(id),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await purchaseResubmissionHandler(
        req("GET", undefined, owner(), "?x=1&x=2"),
        ctx(id),
      )
    ).status,
  ).toBe(400);
  expect(
    (await copyPurchaseHandler(req("POST", { version }), ctx("bad-id"))).status,
  ).toBe(400);
  expect(
    (
      await copyPurchaseHandler(
        req("POST", { version }, "", "", {
          Cookie: `approval_session=${owner()}`,
        }),
        ctx(id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await copyPurchaseHandler(
        req("POST", { version }, owner(), "", {
          Origin: "https://other.invalid",
        }),
        ctx(id),
      )
    ).status,
  ).toBe(403);
  expect((await getPurchaseResubmission(owner(), id)).successor).toBeNull();
});

test("原版本不匹配拒绝，已有后续草稿也不能绕过版本校验", async () => {
  const value = await terminal();
  for (const withChild of [false, true]) {
    if (withChild) await copy(value);
    const response = await copyPurchaseHandler(
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
      copyPurchaseHandler(
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
  await replacePurchaseDraft(
    owner(),
    id,
    replacePurchaseDraftSchema.parse({
      ...fields,
      title: "用户修改",
      version: 1,
    }),
  );
  expect((await copy(value)).successor).toMatchObject({ id, version: 2 });
  expect((await getPurchaseDraft(owner(), id)).title).toBe("用户修改");
});

test("删除未提交后续草稿可重建，再次终态沿链重提不覆盖旧链", async () => {
  const value = await terminal();
  const first = await copy(value);
  await deletePurchaseDraft(owner(), first.successor.id, 1);
  expect(
    (await getPurchaseResubmission(owner(), value.application.id)).successor,
  ).toBeNull();
  const second = await copy(value);
  expect(second.successor.id).not.toBe(first.successor.id);
  const sent = await submitPurchaseDraft(owner(), second.successor.id, 1);
  const cancelled = await withdrawPurchaseApplication(
    owner(),
    sent.application.id,
    { version: sent.application.version, opinion: "" },
  );
  const third = await copy(cancelled);
  expect(
    (await getPurchaseDraft(owner(), third.successor.id)).resubmissionOf,
  ).toBe(second.successor.id);
  expect((await copy(value)).successor.id).toBe(second.successor.id);
  expect(await getPurchaseApplication(owner(), value.application.id)).toEqual(
    value,
  );
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
      "INSERT INTO applications(type,applicant_id,department_id,resubmission_of) SELECT 'purchase',$1,department_id,$2 FROM users WHERE id=$1",
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

test.each(["purchase_requests", "purchase_items", "supplier_quotes"])(
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
      (await getPurchaseResubmission(owner(), value.application.id)).successor,
    ).toBeNull();
    expect(await getPurchaseApplication(owner(), value.application.id)).toEqual(
      value,
    );
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
  expect((await getPurchaseDraft(owner(), child.id)).departmentId).toBe(
    department,
  );
  const sent = await submitPurchaseDraft(owner(), child.id, 1);
  expect(sent.tasks[0].approverId).toBe(people.other.id);
  await expect(
    getPurchaseApplication(people.head.token, child.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    getPurchaseApplication(people.other.token, value.application.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(await getPurchaseApplication(owner(), value.application.id)).toEqual(
    value,
  );
});

test("重复迁移与连接重建保留来源及后续链接", async () => {
  const value = await terminal();
  await copy(value);
  const before = await getPurchaseResubmission(owner(), value.application.id);
  await migrate();
  await closeDatabase();
  expect(await getPurchaseResubmission(owner(), value.application.id)).toEqual(
    before,
  );
});

test("单一来源及未知报价可复制，线上证据必须重新上传且原报价 ID 不能复用", async () => {
  const draft = await createPurchaseDraft(
    owner(),
    purchaseDraftSchema.parse({
      ...fields,
      singleSource: true,
      singleSourceReason: "独家兼容",
      quotes: [
        {
          ...fields.quotes[0],
          amount: null,
          basis: "待询价明细",
          isOnline: true,
          purchaseUrl: "https://example.invalid/item",
        },
      ],
    }),
  );
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const upload = await uploadPurchaseAttachment(
    owner(),
    draft.id,
    draft.quotes[0].id,
    1,
    png,
    "报价.png",
    "image/png",
  );
  const sent = await submitPurchaseDraft(owner(), draft.id, upload.version);
  const original = await withdrawPurchaseApplication(owner(), draft.id, {
    version: sent.application.version,
    opinion: "",
  });
  const child = (await copy(original)).successor;
  const saved = await getPurchaseDraft(owner(), child.id);
  expect(saved).toMatchObject({
    singleSource: true,
    singleSourceReason: "独家兼容",
    quotes: [{ amount: null, isOnline: true, selected: true }],
  });
  const before = await counts();
  await expect(submitPurchaseDraft(owner(), child.id, 1)).rejects.toMatchObject(
    { name: "ZodError" },
  );
  expect(await counts()).toEqual(before);
  await expect(
    uploadPurchaseAttachment(
      owner(),
      child.id,
      draft.quotes[0].id,
      1,
      png,
      "旧报价.png",
      "image/png",
    ),
  ).rejects.toMatchObject({ status: 404 });
  const evidence = await uploadPurchaseAttachment(
    owner(),
    child.id,
    saved.quotes[0].id,
    1,
    png,
    "新报价.png",
    "image/png",
  );
  const next = await submitPurchaseDraft(owner(), child.id, evidence.version);
  expect(next.workflow.routeSnapshot.selectedQuoteId).toBe(saved.quotes[0].id);
  expect(next.workflow.routeSnapshot.lowestQuoteAmount).toBeNull();
  expect(next.workflow.routeSnapshot.attachmentEvidence[0].id).not.toBe(
    upload.attachment.id,
  );
  expect(
    await getPurchaseApplication(owner(), original.application.id),
  ).toEqual(original);
});

test("采购和差旅来源不能混用，新增来源字段不能由普通草稿写入", async () => {
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
    purchaseDraftSchema.safeParse({
      ...fields,
      resubmissionOf: original.application.id,
    }).success,
  ).toBe(false);
  expect(
    replacePurchaseDraftSchema.safeParse({
      ...fields,
      version: 1,
      resubmissionOf: original.application.id,
    }).success,
  ).toBe(false);
});
