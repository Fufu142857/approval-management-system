import { reimbursementDraftSchema } from "../src/lib/reimbursement";
import { getTravelDraftHandler } from "../src/server/travel-handlers";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  createReimbursementDraftHandler as create,
  listReimbursementDraftsHandler as list,
  getReimbursementDraftHandler as get,
  replaceReimbursementDraftHandler as replace,
  deleteReimbursementDraftHandler as remove,
  reimbursementLinkOptionsHandler as options,
} from "../src/server/reimbursement-handlers";

const origin = "http://localhost:3000";
let departmentId: string;
let ownerId: string;
let ownerToken: string;
let otherToken: string;
let adminToken: string;
let pendingToken: string;
function request(
  method = "GET",
  body?: unknown,
  token = ownerToken,
  suffix = "",
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/reimbursement-drafts${suffix}`, {
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
const fields = {
  title: "出差费用报销",
  description: "业务交流费用",
  independentReason: "临时支出",
  remarks: "完整备注",
  items: [
    {
      category: "transport",
      expenseDate: "2028-02-29",
      purpose: "交通",
      amount: "0.10",
    },
    {
      category: "lodging",
      expenseDate: "2028-03-01",
      purpose: "住宿",
      amount: "0.20",
    },
    {
      category: "meals",
      expenseDate: "2028-03-01",
      purpose: "餐饮",
      amount: "1.23",
      noReceipt: true,
      noReceiptReason: "票据遗失",
    },
  ],
};
async function draft(body: unknown = fields) {
  const response = await create(request("POST", body));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).data;
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
  process.env.APP_ORIGIN = origin;
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await seedOrganization("Travel-test-password");
  const admin = (
    await database().query(
      "SELECT id,department_id FROM users WHERE username='admin'",
    )
  ).rows[0];
  departmentId = admin.department_id;
  adminToken = await session(admin.id);
  for (const username of ["traveler", "colleague", "unconfirmed"]) {
    const row = (
      await database().query(
        `INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
       SELECT $1::text,$1::text,$1::text||'@example.invalid',password_hash,department_id,
         CASE WHEN $1::text='unconfirmed' THEN NULL ELSE department_id END,
         CASE WHEN $1::text='unconfirmed' THEN 'pending' ELSE 'active' END
       FROM users WHERE username='admin' RETURNING id`,
        [username],
      )
    ).rows[0];
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
      [row.id],
    );
    const token = await session(row.id);
    if (username === "traveler") {
      ownerId = row.id;
      ownerToken = token;
    } else if (username === "colleague") {
      otherToken = token;
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'department_head')",
        [row.id],
      );
    } else pendingToken = token;
  }
});
afterAll(closeDatabase);

async function source(
  type: "travel" | "purchase" = "travel",
  state = "approved",
  token = ownerToken,
) {
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) SELECT id,code FROM users CROSS JOIN (VALUES ('finance_approver'),('company_head')) r(code) WHERE username='admin' ON CONFLICT DO NOTHING",
  );
  if (type === "travel") {
    const { travelDraftSchema } = await import("../src/lib/travel");
    const { createTravelDraft } = await import("../src/server/travel");
    const { submitTravelDraft } =
      await import("../src/server/travel-submission");
    const { decideTravelTask, withdrawTravelApplication } =
      await import("../src/server/travel-actions");
    const saved = await createTravelDraft(
      token,
      travelDraftSchema.parse({
        title: "已批差旅",
        departure: "杭州",
        destination: "上海",
        startDate: "2028-02-28",
        endDate: "2028-03-01",
        purpose: "交流",
        transportation: "高铁",
        budget: "200",
      }),
    );
    if (state === "draft") return saved;
    let result = await submitTravelDraft(token, saved.id, saved.version);
    if (state === "pending") return result.application;
    if (state === "withdrawn")
      return (
        await withdrawTravelApplication(token, saved.id, {
          version: result.application.version,
          opinion: "",
        })
      ).application;
    result = await decideTravelTask(otherToken, saved.id, result.tasks[0].id, {
      version: result.application.version,
      decision: state === "rejected" ? "reject" : "approve",
      opinion: "核对",
    });
    if (state === "rejected") return result.application;
    return (
      await decideTravelTask(adminToken, saved.id, result.tasks[1].id, {
        version: result.application.version,
        decision: "approve",
        opinion: "",
      })
    ).application;
  }
  const { purchaseDraftSchema } = await import("../src/lib/purchase");
  const { createPurchaseDraft } = await import("../src/server/purchase");
  const { submitPurchaseDraft } =
    await import("../src/server/purchase-submission");
  const { decidePurchaseTask } = await import("../src/server/purchase-actions");
  const saved = await createPurchaseDraft(
    token,
    purchaseDraftSchema.parse({
      title: "已批采购",
      reason: "设备",
      expectedDate: "2028-03-01",
      budgetLimit: "100",
      selectionReason: "独家适配",
      singleSource: true,
      singleSourceReason: "仅此供应商",
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
          basis: "报价记录",
          selected: true,
        },
      ],
    }),
  );
  let result = await submitPurchaseDraft(token, saved.id, saved.version);
  result = await decidePurchaseTask(otherToken, saved.id, result.tasks[0].id, {
    version: result.application.version,
    decision: "approve",
    opinion: "",
  });
  return (
    await decidePurchaseTask(adminToken, saved.id, result.tasks[1].id, {
      version: result.application.version,
      decision: "approve",
      opinion: "",
    })
  ).application;
}
async function read(id: string) {
  const response = await get(request(), context(id));
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

test("未完成草稿保存、编号与身份、重复迁移/重连持久化且不产生审批", async () => {
  const value = await draft({ title: "  未完成  " });
  expect(value).toMatchObject({
    title: "未完成",
    applicantId: ownerId,
    departmentId,
    type: "reimbursement",
    status: "draft",
    version: 1,
    submittedAt: null,
    totalAmount: null,
    noReceiptCount: 0,
    items: [],
    linkedApplicationIds: [],
    linkedApplications: [],
  });
  expect(value.appNo).toMatch(/^APP-\d+$/);
  await migrate();
  await closeDatabase();
  expect(await read(value.id)).toEqual(value);
  for (const table of [
    "approval_instances",
    "approval_tasks",
    "approval_logs",
    "notifications",
    "attachments",
  ])
    expect(
      (await database().query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n,
    ).toBe(0);
});
test("至少三条费用与五类预设、分位精确合计和无票标记；缺金额不当零", async () => {
  const value = await draft();
  expect(value.totalAmount).toBe("1.53");
  expect(value.noReceiptCount).toBe(1);
  expect(value.items[2]).toMatchObject({
    category: "meals",
    noReceipt: true,
    noReceiptReason: "票据遗失",
    amount: "1.23",
  });
  const partial = await draft({
    items: [
      {},
      { amount: "0.1", category: "office" },
      { category: "other", noReceipt: true },
    ],
  });
  expect(partial.totalAmount).toBeNull();
  expect(partial.items[1].amount).toBe("0.10");
  expect(
    (
      await draft({
        items: [{ amount: "999999999999.98" }, { amount: "0.01" }],
      })
    ).totalAmount,
  ).toBe("999999999999.99");
  expect(
    (
      await create(
        request("POST", {
          items: [{ amount: "999999999999.99" }, { amount: "0.01" }],
        }),
      )
    ).status,
  ).toBe(400);
});
test("严格金额/日期/分类、字段长度与上限，拒绝身份/总额/来源/票据注入", async () => {
  const id = randomUUID();
  const invalid = [
    ...["0", "-1", "1.001", "1e3", "NaN", "01", "1000000000000", 1].map(
      (amount) => ({ items: [{ amount }] }),
    ),
    { items: [{ expenseDate: "2026-02-29" }] },
    { items: [{ expenseDate: "0000-01-01" }] },
    { items: [{ category: "invalid" }] },
    { items: [{ noReceipt: "true" }] },
    { items: [{ purpose: "x".repeat(2001) }] },
    { items: Array.from({ length: 101 }, () => ({})) },
    { items: [{ id }, { id }] },
    { linkedApplicationIds: [id, id] },
    { linkedApplicationIds: ["bad"] },
    { linkedApplicationIds: Array.from({ length: 21 }, () => randomUUID()) },
    { applicantId: ownerId },
    { departmentId },
    { type: "purchase" },
    { status: "approved" },
    { totalAmount: "1" },
    { version: 1 },
    { resubmissionOf: id },
    { items: [{ receiptIds: [id] }] },
  ];
  for (const body of invalid)
    expect((await create(request("POST", body))).status).toBe(400);
  expect(
    reimbursementDraftSchema.safeParse({ items: [{ amount: "bad" }] }).success,
  ).toBe(false);
  expect(
    (await database().query("SELECT count(*)::int AS n FROM applications"))
      .rows[0].n,
  ).toBe(0);
});
test("PUT 完整替换保留稳定行 ID/重排，删除省略行，清空字段与关联", async () => {
  const original = await source();
  const value = await draft({ ...fields, linkedApplicationIds: [original.id] });
  const response = await replace(
    request("PUT", {
      ...fields,
      version: 1,
      items: [
        value.items[2],
        value.items[0],
        { amount: "2", category: "other" },
      ],
    }),
    context(value.id),
  );
  expect(response.status).toBe(200);
  const updated = (await response.json()).data;
  expect(
    updated.items.slice(0, 2).map((row: { id: string }) => row.id),
  ).toEqual([value.items[2].id, value.items[0].id]);
  expect(updated.items[2].id).not.toBe(value.items[1].id);
  expect(updated).toMatchObject({
    version: 2,
    totalAmount: "3.33",
    linkedApplications: [],
    linkedApplicationIds: [],
  });
  expect(
    (await replace(request("PUT", { version: 2 }), context(value.id))).status,
  ).toBe(200);
  expect(await read(value.id)).toMatchObject({
    title: "",
    description: "",
    independentReason: "",
    remarks: "",
    items: [],
    totalAmount: null,
    version: 3,
  });
});
test("草稿行不可跨申请，创建拒绝指定行 ID，失败不改原单", async () => {
  const a = await draft(),
    b = await draft();
  for (const id of [b.items[0].id, randomUUID()]) {
    expect(
      (
        await replace(
          request("PUT", { version: 1, items: [{ id }] }),
          context(a.id),
        )
      ).status,
    ).toBe(400);
    expect((await create(request("POST", { items: [{ id }] }))).status).toBe(
      400,
    );
  }
  expect(await read(a.id)).toEqual(a);
});
test("本人已批差旅/采购可多单关联且提供行程信息，原单正文与历史保持", async () => {
  const travel = await source(),
    purchase = await source("purchase");
  const before = (
    await database().query(
      "SELECT to_jsonb(a) AS value FROM applications a WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[travel.id, purchase.id]],
    )
  ).rows;
  const value = await draft({
    ...fields,
    linkedApplicationIds: [purchase.id, travel.id],
  });
  expect(value.linkedApplicationIds).toEqual([purchase.id, travel.id].sort());
  expect(
    value.linkedApplications.find(
      (row: { id: string }) => row.id === travel.id,
    ),
  ).toMatchObject({
    type: "travel",
    status: "approved",
    travel: {
      departure: "杭州",
      destination: "上海",
      durationDays: 3,
      budget: "200.00",
    },
    purchase: null,
  });
  expect(
    value.linkedApplications.find(
      (row: { id: string }) => row.id === purchase.id,
    ),
  ).toMatchObject({
    type: "purchase",
    purchase: { totalAmount: "50.00", budgetLimit: "100.00" },
    travel: null,
  });
  expect(
    (
      await database().query(
        "SELECT to_jsonb(a) AS value FROM applications a WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[travel.id, purchase.id]],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (await remove(request("DELETE", { version: 1 }), context(value.id))).status,
  ).toBe(200);
  expect(
    (await database().query("SELECT count(*)::int AS n FROM application_links"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await database().query(
        "SELECT to_jsonb(a) AS value FROM applications a WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[travel.id, purchase.id]],
      )
    ).rows,
  ).toEqual(before);
});
test.each(["draft", "pending", "rejected", "withdrawn"])(
  "关联拒绝 %s 来源且创建/替换原子回滚",
  async (state) => {
    const bad = await source("travel", state),
      value = await draft();
    expect(
      (
        await create(
          request("POST", { ...fields, linkedApplicationIds: [bad.id] }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await replace(
          request("PUT", {
            version: 1,
            title: "不应修改",
            linkedApplicationIds: [bad.id],
          }),
          context(value.id),
        )
      ).status,
    ).toBe(404);
    expect(await read(value.id)).toEqual(value);
  },
);
test("关联拒绝他人已批、报销自身、不存在与混合非法 ID，不扩大管理员/负责人权限", async () => {
  const approved = await source(),
    value = await draft();
  const invalid = [value.id, randomUUID()];
  for (const id of invalid)
    expect(
      (
        await create(
          request("POST", { linkedApplicationIds: [approved.id, id] }),
        )
      ).status,
    ).toBe(404);
  for (const token of [otherToken, adminToken]) {
    expect(
      (
        await create(
          request("POST", { linkedApplicationIds: [approved.id] }, token),
        )
      ).status,
    ).toBe(404);
    expect(
      (await (await options(request("GET", undefined, token))).json()).data
        .total,
    ).toBe(0);
    expect(
      (await get(request("GET", undefined, token), context(value.id))).status,
    ).toBe(404);
    expect(
      (await replace(request("PUT", { version: 1 }, token), context(value.id)))
        .status,
    ).toBe(404);
    expect(
      (
        await remove(
          request("DELETE", { version: 1 }, token),
          context(value.id),
        )
      ).status,
    ).toBe(404);
  }
});
test("关联选项只列本人已批，类型/字面关键词/编号分页及空页计数", async () => {
  const travel = await source(),
    purchase = await source("purchase");
  await source("travel", "pending");
  const all = (await (await options(request())).json()).data;
  expect(all.total).toBe(2);
  expect(new Set(all.items.map((row: { id: string }) => row.id))).toEqual(
    new Set([travel.id, purchase.id]),
  );
  expect(all.items[0].travel).toBeUndefined();
  const filtered = (
    await (
      await options(
        request("GET", undefined, ownerToken, "?type=travel&pageSize=1"),
      )
    ).json()
  ).data;
  expect(filtered).toMatchObject({
    total: 1,
    page: 1,
    pageSize: 1,
    items: [{ id: travel.id }],
  });
  expect(
    (
      await (
        await options(
          request(
            "GET",
            undefined,
            ownerToken,
            `?keyword=${purchase.appNo.toLowerCase()}`,
          ),
        )
      ).json()
    ).data.total,
  ).toBe(1);
  expect(
    (
      await (
        await options(
          request("GET", undefined, ownerToken, "?page=3&pageSize=1"),
        )
      ).json()
    ).data,
  ).toMatchObject({ items: [], total: 2 });
  for (const q of [
    "?type=reimbursement",
    "?type=travel&type=purchase",
    "?status=approved",
    "?applicantId=x",
    "?page=0",
  ])
    expect(
      (await options(request("GET", undefined, ownerToken, q))).status,
    ).toBe(400);
});
test("匿名/失效/待确认/停用和无效部门拒绝，列表无越权", async () => {
  const value = await draft();
  for (const handler of [list, options]) {
    expect((await handler(request("GET", undefined, ""))).status).toBe(401);
    expect(
      (await handler(request("GET", undefined, pendingToken))).status,
    ).toBe(403);
  }
  expect(
    (await create(request("POST", {}, "", "", { Origin: origin }))).status,
  ).toBe(401);
  expect(
    (await (await list(request("GET", undefined, otherToken))).json()).data
      .total,
  ).toBe(0);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [ownerId],
  );
  expect([401, 403]).toContain(
    (await get(request(), context(value.id))).status,
  );
  await database().query(
    "UPDATE users SET registration_status='active' WHERE id=$1",
    [ownerId],
  );
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    departmentId,
  ]);
  expect((await create(request("POST", {}))).status).toBe(403);
});
test("草稿搜索/分页/空页与类型隔离、未知重复查询参数和无效 UUID", async () => {
  const first = await draft({ title: "100%_报销" });
  await draft({ title: "普通" });
  expect(
    (
      await (
        await list(request("GET", undefined, ownerToken, "?keyword=%25_"))
      ).json()
    ).data,
  ).toMatchObject({ total: 1, items: [{ id: first.id }] });
  const page = (
    await (
      await list(request("GET", undefined, ownerToken, "?page=3&pageSize=1"))
    ).json()
  ).data;
  expect(page).toMatchObject({ total: 2, items: [], page: 3, pageSize: 1 });
  for (const q of [
    "?page=0",
    "?page=1&page=2",
    "?type=travel",
    "?__proto__=x",
    "?pageSize=101",
  ])
    expect((await list(request("GET", undefined, ownerToken, q))).status).toBe(
      400,
    );
  expect((await get(request(), context("bad"))).status).toBe(400);
  expect(
    (
      await get(
        request("GET", undefined, ownerToken, "?x=1"),
        context(first.id),
      )
    ).status,
  ).toBe(400);
  expect(
    (await getTravelDraftHandler(request(), context(first.id))).status,
  ).toBe(404);
  const travel = await source("travel", "draft");
  expect((await get(request(), context(travel.id))).status).toBe(404);
  expect((await (await list(request())).json()).data.total).toBe(2);
});
test("Cookie 同源、JSON/体积限制与大于默认 16KiB 的明细可保存", async () => {
  const headers = { Cookie: `approval_session=${ownerToken}` };
  expect((await create(request("POST", {}, "", "", headers))).status).toBe(403);
  expect(
    (await create(request("POST", {}, "", "", { ...headers, Origin: origin })))
      .status,
  ).toBe(201);
  expect(
    (
      await create(
        request("POST", {}, ownerToken, "", { Origin: "https://evil.invalid" }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await create(
        request("POST", {}, ownerToken, "", { "Content-Type": "text/plain" }),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await draft({
        items: Array.from({ length: 30 }, () => ({
          purpose: "文".repeat(300),
        })),
      })
    ).items,
  ).toHaveLength(30);
  expect(
    (await create(request("POST", { description: "x".repeat(262144) }))).status,
  ).toBe(413);
});
test("并发 PUT/DELETE、旧版本与版本上限，不会丢行或覆盖", async () => {
  const value = await draft();
  const responses = await Promise.all([
    replace(request("PUT", { ...fields, version: 1 }), context(value.id)),
    replace(
      request("PUT", { version: 1, title: "另一窗口" }),
      context(value.id),
    ),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (await remove(request("DELETE", { version: 1 }), context(value.id))).status,
  ).toBe(409);
  const concurrent = await Promise.all([
    replace(request("PUT", { version: 2 }), context(value.id)),
    remove(request("DELETE", { version: 2 }), context(value.id)),
  ]);
  expect(concurrent.filter((r) => r.status === 200)).toHaveLength(1);
  const max = await draft();
  await database().query(
    "UPDATE applications SET version=2147483647 WHERE id=$1",
    [max.id],
  );
  expect(
    (await replace(request("PUT", { version: 2147483647 }), context(max.id)))
      .status,
  ).toBe(409);
  expect(
    (await remove(request("DELETE", { version: 2147483647 }), context(max.id)))
      .status,
  ).toBe(200);
});
test("非草稿不可读改删且不进入列表，数据库冻结正文与费用行", async () => {
  const value = await draft();
  await database().query(
    "UPDATE applications SET status='pending',submitted_at=now() WHERE id=$1",
    [value.id],
  );
  expect((await get(request(), context(value.id))).status).toBe(409);
  expect(
    (await replace(request("PUT", { version: 1 }), context(value.id))).status,
  ).toBe(409);
  expect(
    (await remove(request("DELETE", { version: 1 }), context(value.id))).status,
  ).toBe(409);
  expect((await (await list(request())).json()).data.total).toBe(0);
  await expect(
    database().query("DELETE FROM reimbursement_items WHERE app_id=$1", [
      value.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query(
      "UPDATE reimbursement_requests SET description='x' WHERE app_id=$1",
      [value.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
test.each(["reimbursement_items", "application_links"])(
  "%s 插入故障回滚创建和替换，原费用与关联保留",
  async (table) => {
    const approved = await source(),
      value = await draft({ ...fields, linkedApplicationIds: [approved.id] });
    await database().query(
      `CREATE FUNCTION fail_reimbursement_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture fault'; END $$; CREATE TRIGGER fail_reimbursement_test BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_reimbursement_test()`,
    );
    try {
      const body = { ...fields, linkedApplicationIds: [approved.id] };
      expect((await create(request("POST", body))).status).toBe(500);
      expect(
        (
          await replace(
            request("PUT", { ...body, title: "不得保留", version: 1 }),
            context(value.id),
          )
        ).status,
      ).toBe(500);
    } finally {
      await database().query(
        `DROP TRIGGER fail_reimbursement_test ON ${table}; DROP FUNCTION fail_reimbursement_test()`,
      );
    }
    expect(await read(value.id)).toEqual(value);
    expect(
      (
        await database().query(
          "SELECT count(*)::int AS n FROM applications WHERE type='reimbursement'",
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
test("数据库拒绝跨行归属、重复顺序/关联、非法金额及关联身份改写", async () => {
  const approved = await source(),
    first = await draft({ ...fields, linkedApplicationIds: [approved.id] }),
    second = await draft();
  for (const [sql, values, code] of [
    [
      "UPDATE reimbursement_items SET app_id=$2 WHERE id=$1",
      [first.items[0].id, second.id],
      "23514",
    ],
    [
      "UPDATE reimbursement_items SET id=$2 WHERE id=$1",
      [first.items[0].id, randomUUID()],
      "23514",
    ],
    [
      "UPDATE reimbursement_items SET position=1 WHERE app_id=$1",
      [first.id],
      "23505",
    ],
    [
      "UPDATE reimbursement_items SET amount=0 WHERE app_id=$1",
      [first.id],
      "23514",
    ],
    [
      "UPDATE applications SET applicant_id=(SELECT id FROM users WHERE username='colleague') WHERE id=$1",
      [first.id],
      "23514",
    ],
    ["UPDATE applications SET type='travel' WHERE id=$1", [first.id], "23514"],
    [
      "INSERT INTO application_links(source_app_id,target_app_id) VALUES ($1,$2)",
      [approved.id, first.id],
      "23505",
    ],
    [
      "INSERT INTO application_links(source_app_id,target_app_id) VALUES ($1,$2)",
      [second.id, first.id],
      "23514",
    ],
    [
      "UPDATE application_links SET target_app_id=$2 WHERE target_app_id=$1",
      [first.id, second.id],
      "23514",
    ],
  ] as [string, string[], string][])
    await expect(database().query(sql, values)).rejects.toMatchObject({ code });
  expect(await read(first.id)).toEqual(first);
});
test("详情等待申请写锁后读取完整标题/金额，部门采用当前有效身份", async () => {
  const value = await draft(),
    client = await database().connect();
  let response: Promise<Response> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM applications WHERE id=$1 FOR UPDATE", [
      value.id,
    ]);
    await client.query(
      "UPDATE applications SET title='一致新标题',version=2 WHERE id=$1",
      [value.id],
    );
    let settled = false;
    response = get(request(), context(value.id)).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
    await client.query(
      "UPDATE reimbursement_items SET amount=1 WHERE app_id=$1",
      [value.id],
    );
    await client.query("COMMIT");
    expect((await (await response).json()).data).toMatchObject({
      title: "一致新标题",
      version: 2,
      totalAmount: "3.00",
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await response;
  }
  const department = (
    await database().query("SELECT id FROM departments WHERE name='财务部'")
  ).rows[0].id;
  await database().query("UPDATE users SET department_id=$2 WHERE id=$1", [
    ownerId,
    department,
  ]);
  expect(
    (
      await (
        await replace(request("PUT", { version: 2 }), context(value.id))
      ).json()
    ).data.departmentId,
  ).toBe(department);
});

test("读取关联重新核所有权，异常来源不会泄露正文且可清除关联恢复草稿", async () => {
  const approved = await source(),
    value = await draft({ ...fields, linkedApplicationIds: [approved.id] });
  // Simulate out-of-band source corruption; API users cannot transfer an approved application.
  await database().query(
    "UPDATE applications SET applicant_id=(SELECT id FROM users WHERE username='colleague') WHERE id=$1",
    [approved.id],
  );
  const denied = await get(request(), context(value.id));
  expect(denied.status).toBe(404);
  expect((await denied.json()).data).toBeUndefined();
  expect(
    (
      await replace(
        request("PUT", { ...fields, version: 1, linkedApplicationIds: [] }),
        context(value.id),
      )
    ).status,
  ).toBe(200);
  expect((await read(value.id)).linkedApplications).toEqual([]);
});
