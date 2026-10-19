import { purchaseDraftSchema } from "../src/lib/purchase";
import { getTravelDraftHandler } from "../src/server/travel-handlers";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  createPurchaseDraftHandler as create,
  listPurchaseDraftsHandler as list,
  getPurchaseDraftHandler as get,
  replacePurchaseDraftHandler as replace,
  deletePurchaseDraftHandler as remove,
} from "../src/server/purchase-handlers";

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
  return new Request(`${origin}/api/purchase-drafts${suffix}`, {
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
  title: "办公设备采购",
  reason: "更换设备",
  expectedDate: "2028-02-29",
  project: "研发",
  budgetLimit: "1000.10",
  selectionReason: "送货更快",
  singleSource: false,
  singleSourceReason: "",
  remarks: "送至办公室",
  items: [
    {
      name: "纸张",
      specification: "A4",
      quantity: "1.5",
      unit: "包",
      unitPrice: "0.33",
    },
    { name: "笔", quantity: "3", unit: "支", unitPrice: "0.10" },
  ],
  quotes: [
    {
      supplierName: "甲",
      quoteDate: "2028-02-28",
      amount: "0.80",
      basis: "电话询价",
      selected: true,
    },
    {
      supplierName: "乙",
      quoteDate: "2028-02-29",
      amount: "0.70",
      purchaseUrl: "https://example.invalid/item",
      isOnline: true,
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

function editable(value: Awaited<ReturnType<typeof draft>>) {
  return {
    ...fields,
    items: value.items.map(
      ({ amount, ...row }: { amount: string | null; id: string }) => {
        void amount;
        return row;
      },
    ),
    quotes: value.quotes,
    version: value.version,
  };
}
test("未完成草稿可保存，身份编号与空值由服务器确定；重复迁移/连接重建保留", async () => {
  const value = await draft({ title: "  未完成  " });
  expect(value).toMatchObject({
    title: "未完成",
    applicantId: ownerId,
    departmentId,
    type: "purchase",
    status: "draft",
    version: 1,
    items: [],
    quotes: [],
    totalAmount: null,
    budgetLimit: null,
    expectedDate: null,
    submittedAt: null,
  });
  expect(value.appNo).toMatch(/^APP-\d+$/);
  await migrate();
  await closeDatabase();
  expect((await (await get(request(), context(value.id))).json()).data).toEqual(
    value,
  );
  for (const table of [
    "approval_instances",
    "approval_tasks",
    "approval_logs",
    "notifications",
  ])
    expect(
      (await database().query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n,
    ).toBe(0);
});
test("两条明细/两家报价、逐行精确舍入和汇总；预算与比价提交条件暂不限制草稿", async () => {
  const value = await draft({ ...fields, budgetLimit: "0" });
  expect(value.totalAmount).toBe("0.80");
  expect(value.items.map((row: { amount: string }) => row.amount)).toEqual([
    "0.50",
    "0.30",
  ]);
  expect(value.items[0]).toMatchObject({
    quantity: "1.500",
    unitPrice: "0.33",
    specification: "A4",
  });
  expect(value.quotes[0]).toMatchObject({ selected: true, amount: "0.80" });
  expect(value.quotes[1]).toMatchObject({ selected: false, isOnline: true });
  const partial = await draft({
    items: [{ quantity: "1", unitPrice: "0.01" }, {}],
    quotes: [{ selected: true }],
    singleSource: true,
  });
  expect(partial.totalAmount).toBeNull();
  expect(partial.items[1].amount).toBeNull();
});
test("精度上限与大数合计不受 JavaScript 浮点影响", async () => {
  const value = await draft({
    items: [{ quantity: "1", unitPrice: "999999999999.99" }],
  });
  expect(value.totalAmount).toBe("999999999999.99");
  const fractional = await draft({
    items: [
      { quantity: "0.001", unitPrice: "5" },
      { quantity: "0.001", unitPrice: "4.99" },
    ],
  });
  expect(fractional.items.map((row: { amount: string }) => row.amount)).toEqual(
    ["0.01", "0.00"],
  );
  expect(fractional.totalAmount).toBe("0.01");
  for (const items of [
    [{ quantity: "2", unitPrice: "999999999999.99" }],
    [
      { quantity: "1", unitPrice: "999999999999.99" },
      { quantity: "1", unitPrice: "0.01" },
    ],
  ])
    expect((await create(request("POST", { items }))).status).toBe(400);
});
test("非法数量/金额/日期/链接、重复行 ID、多选与客户端总额和身份字段拒绝", async () => {
  const invalid: unknown[] = [
    { items: [{ quantity: "0" }] },
    { items: [{ quantity: "-1" }] },
    { items: [{ quantity: "1.0001" }] },
    { items: [{ quantity: 1 }] },
    { items: [{ quantity: "1e3" }] },
    { items: [{ unitPrice: "0" }] },
    { items: [{ unitPrice: "NaN" }] },
    { items: [{ unitPrice: "1.001" }] },
    { items: [{ amount: "1" }] },
    { budgetLimit: "-1" },
    { expectedDate: "2026-02-29" },
    { expectedDate: "0000-01-01" },
    { quotes: [{ amount: "0" }] },
    { quotes: [{ quoteDate: "2026-13-01" }] },
    { quotes: [{ purchaseUrl: "javascript:alert(1)" }] },
    { quotes: [{ purchaseUrl: "https://u:p@example.invalid" }] },
    { quotes: [{ selected: true }, { selected: true }] },
    { applicantId: ownerId },
    { departmentId },
    { type: "travel" },
    { totalAmount: "1" },
    { version: 1 },
    { items: Array.from({ length: 101 }, () => ({})) },
    { quotes: Array.from({ length: 21 }, () => ({})) },
  ];
  const duplicate = randomUUID();
  invalid.push({ items: [{ id: duplicate }, { id: duplicate }] });
  for (const body of invalid)
    expect((await create(request("POST", body))).status).toBe(400);
  expect(
    (await database().query("SELECT count(*)::int AS n FROM applications"))
      .rows[0].n,
  ).toBe(0);
  expect(
    purchaseDraftSchema.safeParse({
      items: [{ quantity: "abc", unitPrice: "3" }],
    }).success,
  ).toBe(false);
});
test("PUT 完整替换保留已知行 ID/排序，删除省略行并新增 ID，切换供应商", async () => {
  const value = await draft();
  const body = editable(value);
  body.items = [body.items[1], body.items[0]];
  body.quotes = body.quotes
    .slice()
    .reverse()
    .map((row: { selected: boolean }, i: number) => ({
      ...row,
      selected: i === 0,
    }));
  const response = await replace(request("PUT", body), context(value.id));
  expect(response.status).toBe(200);
  const edited = (await response.json()).data;
  expect(edited.items.map((row: { id: string }) => row.id)).toEqual([
    value.items[1].id,
    value.items[0].id,
  ]);
  expect(edited.quotes[0]).toMatchObject({
    id: value.quotes[1].id,
    selected: true,
  });
  expect(edited.version).toBe(2);
  expect(edited.appNo).toBe(value.appNo);
  const replaced = await replace(
    request("PUT", { version: 2, items: [{ name: "新明细" }] }),
    context(value.id),
  );
  expect(replaced.status).toBe(200);
  const cleared = (await replaced.json()).data;
  expect(cleared).toMatchObject({
    title: "",
    reason: "",
    budgetLimit: null,
    quotes: [],
    version: 3,
    totalAmount: null,
  });
  expect(cleared.items[0].id).not.toBe(value.items[0].id);
  expect(
    (
      await database().query(
        "SELECT count(*)::int AS n FROM purchase_items WHERE app_id=$1",
        [value.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
test("草稿行不可跨申请/类别引用，新建时也不接受调用方分配 ID", async () => {
  const first = await draft(),
    second = await draft();
  for (const body of [
    { ...editable(first), items: [{ id: second.items[0].id }] },
    { ...editable(first), quotes: [{ id: first.items[0].id }] },
    { ...editable(first), items: [{ id: randomUUID() }] },
  ])
    expect(
      (await replace(request("PUT", body), context(first.id))).status,
    ).toBe(400);
  expect(
    (await create(request("POST", { items: [{ id: randomUUID() }] }))).status,
  ).toBe(400);
  expect((await (await get(request(), context(first.id))).json()).data).toEqual(
    first,
  );
});
test("匿名/待确认/停用/无效部门拒绝，管理员/同部门负责人不获本人草稿权限", async () => {
  const value = await draft();
  expect(
    (await create(request("POST", {}, "", "", { Origin: origin }))).status,
  ).toBe(401);
  expect((await list(request("GET", undefined, pendingToken))).status).toBe(
    403,
  );
  for (const token of [otherToken, adminToken]) {
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
    expect(
      (await (await list(request("GET", undefined, token))).json()).data.total,
    ).toBe(0);
  }
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
test("详情与列表只返回采购；差旅接口也不能读取采购", async () => {
  const value = await draft();
  expect(
    (await getTravelDraftHandler(request(), context(value.id))).status,
  ).toBe(404);
  const travel = (
    await database().query(
      "INSERT INTO applications(applicant_id,department_id) VALUES ($1,$2) RETURNING id",
      [ownerId, departmentId],
    )
  ).rows[0];
  await database().query("INSERT INTO travel_requests(app_id) VALUES ($1)", [
    travel.id,
  ]);
  expect((await get(request(), context(travel.id))).status).toBe(404);
  expect((await (await list(request())).json()).data.total).toBe(1);
});
test("分页/标题和编号搜索/空页总数、未知重复查询参数与无效 UUID", async () => {
  const first = await draft({ title: "100%_采购" });
  await draft({ title: "普通采购" });
  const search = (
    await (
      await list(request("GET", undefined, ownerToken, "?keyword=%25_"))
    ).json()
  ).data;
  expect(search.total).toBe(1);
  expect(search.items[0].id).toBe(first.id);
  expect(search.items[0].items).toBeUndefined();
  const byNo = (
    await (
      await list(
        request(
          "GET",
          undefined,
          ownerToken,
          `?keyword=${first.appNo.toLowerCase()}`,
        ),
      )
    ).json()
  ).data;
  expect(byNo.total).toBe(1);
  const page = (
    await (
      await list(request("GET", undefined, ownerToken, "?page=3&pageSize=1"))
    ).json()
  ).data;
  expect(page).toMatchObject({ total: 2, items: [], page: 3, pageSize: 1 });
  for (const suffix of [
    "?page=0",
    "?page=1&page=2",
    "?type=travel",
    "?__proto__=x",
    "?pageSize=101",
  ])
    expect(
      (await list(request("GET", undefined, ownerToken, suffix))).status,
    ).toBe(400);
  expect((await get(request(), context("bad"))).status).toBe(400);
  expect(
    (
      await get(
        request("GET", undefined, ownerToken, "?x=1"),
        context(first.id),
      )
    ).status,
  ).toBe(400);
});
test("Cookie 同源写、JSON 类型与 256 KiB 体积限制", async () => {
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
  const long = await draft({
    items: Array.from({ length: 60 }, () => ({
      specification: "文".repeat(300),
    })),
  });
  expect(long.items).toHaveLength(60);
  expect(
    (await create(request("POST", { reason: "x".repeat(262144) }))).status,
  ).toBe(413);
});
test("并发 PUT/DELETE 与旧版本至多一次成功且不会丢失行", async () => {
  const value = await draft();
  const responses = await Promise.all([
    replace(
      request("PUT", { ...fields, title: "新内容", version: 1 }),
      context(value.id),
    ),
    replace(
      request("PUT", { version: 1, title: "另一个窗口" }),
      context(value.id),
    ),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const current = (await (await get(request(), context(value.id))).json()).data;
  expect(current.version).toBe(2);
  expect(
    (await remove(request("DELETE", { version: 1 }), context(value.id))).status,
  ).toBe(409);
  const race = await Promise.all([
    replace(request("PUT", { version: 2, title: "再修改" }), context(value.id)),
    remove(request("DELETE", { version: 2 }), context(value.id)),
  ]);
  expect(race.filter((r) => r.status === 200)).toHaveLength(1);
  expect([404, 409]).toContain(race.find((r) => r.status !== 200)?.status);
});
test("保存随当前部门，达到版本上限拒绝编辑，显式删除清理所有子行", async () => {
  const value = await draft();
  const next = (
    await database().query("SELECT id FROM departments WHERE id<>$1 LIMIT 1", [
      departmentId,
    ])
  ).rows[0].id;
  await database().query("UPDATE users SET department_id=$2 WHERE id=$1", [
    ownerId,
    next,
  ]);
  const edited = (
    await (
      await replace(
        request("PUT", { ...fields, version: 1 }),
        context(value.id),
      )
    ).json()
  ).data;
  expect(edited.departmentId).toBe(next);
  await database().query(
    "UPDATE applications SET version=2147483647 WHERE id=$1",
    [value.id],
  );
  expect(
    (await replace(request("PUT", { version: 2147483647 }), context(value.id)))
      .status,
  ).toBe(409);
  expect(
    (
      await remove(
        request("DELETE", { version: 2147483647 }),
        context(value.id),
      )
    ).status,
  ).toBe(200);
  for (const table of [
    "applications",
    "purchase_requests",
    "purchase_items",
    "supplier_quotes",
  ])
    expect(
      (await database().query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n,
    ).toBe(0);
});
test("非草稿拒绝读写删；数据库阻止采购明细变动、跨类型关联及换类型", async () => {
  const value = await draft();
  await expect(
    database().query("UPDATE applications SET type='travel' WHERE id=$1", [
      value.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  const travel = (
    await database().query(
      "INSERT INTO applications(applicant_id,department_id) VALUES ($1,$2) RETURNING id",
      [ownerId, departmentId],
    )
  ).rows[0];
  await expect(
    database().query("INSERT INTO purchase_requests(app_id) VALUES ($1)", [
      travel.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
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
    database().query("DELETE FROM purchase_items WHERE app_id=$1", [value.id]),
  ).rejects.toMatchObject({ code: "23514" });
});
test("明细插入故障回滚创建与整单替换，不能留下半张采购单", async () => {
  const value = await draft();
  await database().query(
    "CREATE FUNCTION fail_purchase_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture fault'; END $$; CREATE TRIGGER fail_purchase_test BEFORE INSERT ON supplier_quotes FOR EACH ROW EXECUTE FUNCTION fail_purchase_test()",
  );
  try {
    expect((await create(request("POST", fields))).status).toBe(500);
    expect(
      (
        await replace(
          request("PUT", { ...fields, title: "不能保留", version: 1 }),
          context(value.id),
        )
      ).status,
    ).toBe(500);
  } finally {
    await database().query(
      "DROP TRIGGER fail_purchase_test ON supplier_quotes; DROP FUNCTION fail_purchase_test()",
    );
  }
  expect((await (await get(request(), context(value.id))).json()).data).toEqual(
    value,
  );
  expect(
    (await database().query("SELECT count(*)::int AS n FROM applications"))
      .rows[0].n,
  ).toBe(1);
});
test("数据库限制行归属、顺序与单选；非法行迁移不会改变原草稿", async () => {
  const first = await draft(),
    second = await draft();
  await expect(
    database().query("UPDATE purchase_items SET app_id=$2 WHERE id=$1", [
      first.items[0].id,
      second.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("UPDATE supplier_quotes SET id=$2 WHERE id=$1", [
      first.quotes[0].id,
      randomUUID(),
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("UPDATE supplier_quotes SET selected=true WHERE id=$1", [
      first.quotes[1].id,
    ]),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    database().query("UPDATE purchase_items SET position=1 WHERE app_id=$1", [
      first.id,
    ]),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    database().query("UPDATE purchase_items SET quantity=0 WHERE id=$1", [
      first.items[0].id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  expect((await (await get(request(), context(first.id))).json()).data).toEqual(
    first,
  );
});
test("多表详情等待申请锁，不拼接未完成写事务的标题和明细金额", async () => {
  const value = await draft();
  const client = await database().connect();
  let response: Promise<Response> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM applications WHERE id=$1 FOR UPDATE", [
      value.id,
    ]);
    await client.query(
      "UPDATE applications SET title='完整新标题',version=2 WHERE id=$1",
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
      "UPDATE purchase_items SET quantity=1,unit_price=1 WHERE app_id=$1",
      [value.id],
    );
    await client.query("COMMIT");
    const result = await response;
    expect(result.status).toBe(200);
    expect((await result.json()).data).toMatchObject({
      title: "完整新标题",
      version: 2,
      totalAmount: "2.00",
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await response;
  }
});
