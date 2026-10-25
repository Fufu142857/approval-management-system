import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { statisticsHandler } from "../src/server/statistics-handlers";
import { getFixedBusinessStatistics } from "../src/server/statistics";
import {
  statisticsSchema,
  type FixedBusinessStatistics,
  type StatisticsType,
} from "../src/lib/statistics";
import { createTravelDraft } from "../src/server/travel";
import { travelDraftSchema } from "../src/lib/travel";
import { submitTravelDraft } from "../src/server/travel-submission";
import {
  decideTravelTask,
  withdrawTravelApplication,
} from "../src/server/travel-actions";
import { createPurchaseDraft } from "../src/server/purchase";
import { purchaseDraftSchema } from "../src/lib/purchase";
import { submitPurchaseDraft } from "../src/server/purchase-submission";
import {
  decidePurchaseTask,
  withdrawPurchaseApplication,
} from "../src/server/purchase-actions";
import { createReimbursementDraft } from "../src/server/reimbursement";
import { reimbursementDraftSchema } from "../src/lib/reimbursement";
import { submitReimbursementDraft } from "../src/server/reimbursement-submission";
import {
  decideReimbursementTask,
  withdrawReimbursementApplication,
} from "../src/server/reimbursement-actions";
import { copyReimbursementForResubmission } from "../src/server/reimbursement-resubmission";

const people: Record<string, { id: string; token: string }> = {};
let departmentId: string;
let otherDepartmentId: string;
const zero = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
const submit = {
  travel: submitTravelDraft,
  purchase: submitPurchaseDraft,
  reimbursement: submitReimbursementDraft,
};
const decide = {
  travel: decideTravelTask,
  purchase: decidePurchaseTask,
  reimbursement: decideReimbursementTask,
};
const withdraw = {
  travel: withdrawTravelApplication,
  purchase: withdrawPurchaseApplication,
  reimbursement: withdrawReimbursementApplication,
};
function request(search = "", person = "owner") {
  return statisticsHandler(
    new Request(`http://localhost:3000/api/statistics${search}`, {
      headers: person
        ? { Authorization: `Bearer ${people[person].token}` }
        : {},
    }),
  );
}
async function stats(
  search = "",
  person = "owner",
): Promise<FixedBusinessStatistics> {
  const response = await request(search, person);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).data;
}
async function draft(type: StatisticsType, person = "owner", amount = "0.10") {
  const token = people[person].token;
  if (type === "travel")
    return createTravelDraft(
      token,
      travelDraftSchema.parse({
        title: "统计私密标题",
        purpose: "不应暴露的正文",
        departure: "杭州",
        destination: "上海",
        startDate: "2028-02-29",
        endDate: "2028-03-01",
        transportation: "高铁",
        budget: amount,
      }),
    );
  if (type === "purchase")
    return createPurchaseDraft(
      token,
      purchaseDraftSchema.parse({
        title: "统计私密标题",
        reason: "设备",
        expectedDate: "2028-03-01",
        budgetLimit: "999999999999.99",
        singleSource: true,
        singleSourceReason: "独家兼容",
        selectionReason: "现有设备",
        items: [
          {
            name: "设备",
            specification: "A",
            quantity: "1",
            unit: "件",
            unitPrice: amount,
          },
        ],
        quotes: [
          {
            supplierName: "供应商",
            basis: "书面报价",
            quoteDate: "2028-02-29",
            amount,
            selected: true,
          },
        ],
      }),
    );
  return createReimbursementDraft(
    token,
    reimbursementDraftSchema.parse({
      title: "统计私密标题",
      description: "不应暴露的正文",
      independentReason: "独立费用",
      items: [
        {
          category: "transport",
          expenseDate: "2028-02-29",
          purpose: "车费",
          amount,
          noReceipt: true,
          noReceiptReason: "不应暴露的原因",
        },
      ],
    }),
  );
}
async function submitted(
  type: StatisticsType = "travel",
  person = "owner",
  amount = "0.10",
) {
  const saved = await draft(type, person, amount);
  return submit[type](people[person].token, saved.id, saved.version);
}
type Detail = Awaited<ReturnType<typeof submitted>>;
async function decision(
  type: StatisticsType,
  app: Detail,
  step = 0,
  action: "approve" | "reject" = "approve",
  person = step ? "finance" : "head",
) {
  return decide[type](
    people[person].token,
    app.application.id,
    app.tasks[step].id,
    {
      version: app.application.version,
      decision: action,
      opinion: action === "reject" ? "退回" : "",
    },
  );
}
async function approved(
  type: StatisticsType = "travel",
  person = "owner",
  amount = "0.10",
) {
  return decision(
    type,
    await decision(type, await submitted(type, person, amount)),
    1,
  );
}
function group(data: FixedBusinessStatistics, type: StatisticsType) {
  return data.applications.byType.find((row) => row.type === type)!;
}
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  await migrate();
});
beforeEach(async () => {
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await seedOrganization("Statistics-test-password");
  departmentId = (
    await database().query("SELECT id FROM departments WHERE name='研发部'")
  ).rows[0].id;
  otherDepartmentId = (
    await database().query("SELECT id FROM departments WHERE name='市场部'")
  ).rows[0].id;
  const adminId = (
    await database().query("SELECT id FROM users WHERE username='admin'")
  ).rows[0].id;
  for (const name of [
    "admin",
    "owner",
    "colleague",
    "outsider",
    "head",
    "other_head",
    "finance",
    "company",
    "pending",
  ]) {
    const dept = ["outsider", "other_head"].includes(name)
      ? otherDepartmentId
      : departmentId;
    const id =
      name === "admin"
        ? adminId
        : (
            await database().query(
              `INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
       SELECT $1::text,$1::text,$1::text||'@example.invalid',password_hash,$2,
       CASE WHEN $1='pending' THEN NULL ELSE $2::uuid END,
       CASE WHEN $1='pending' THEN 'pending' ELSE 'active' END FROM users WHERE id=$3 RETURNING id`,
              [name, dept, adminId],
            )
          ).rows[0].id;
    if (name !== "admin")
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
        [id],
      );
    if (["head", "other_head", "finance"].includes(name))
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, name === "finance" ? "finance_approver" : "department_head"],
      );
    // One valid company approver for fixed purchase. company has no company-wide data grant.
    if (name === "finance")
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'company_head')",
        [id],
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

test("空统计有固定类型及零状态/金额；草稿即使有金额也不进入统计", async () => {
  for (const type of ["travel", "purchase", "reimbursement"] as const)
    await draft(type);
  const data = await stats();
  expect(data.filters).toEqual({
    scope: "personal",
    departmentId: null,
    type: "all",
    from: null,
    to: null,
    timeBasis: "submittedAt",
    timezone: "Asia/Shanghai",
  });
  expect(data.applications).toMatchObject({ total: 0, statuses: zero });
  expect(data.applications.byType).toHaveLength(3);
  for (const row of data.applications.byType)
    expect(row).toMatchObject({
      total: 0,
      statuses: zero,
      approvedAmount: "0.00",
      approvedAmountMissingCount: 0,
    });
  expect(data.pendingTasks.total).toBe(0);
});

test("三类型四状态分布与通过金额分别合计，不含草稿/拒绝/撤回金额且无跨类型金额", async () => {
  for (const [type, amount] of [
    ["travel", "10.01"],
    ["purchase", "20.02"],
    ["reimbursement", "30.03"],
  ] as const) {
    await draft(type);
    await submitted(type);
    await approved(type, "owner", amount);
    await decision(type, await submitted(type), 0, "reject");
    const app = await submitted(type);
    await withdraw[type](people.owner.token, app.application.id, {
      version: app.application.version,
      opinion: "",
    });
  }
  const data = await stats();
  expect(data.applications).toMatchObject({
    total: 12,
    statuses: { pending: 3, approved: 3, rejected: 3, withdrawn: 3 },
  });
  for (const [type, amount] of [
    ["travel", "10.01"],
    ["purchase", "20.02"],
    ["reimbursement", "30.03"],
  ] as const)
    expect(group(data, type)).toMatchObject({
      total: 4,
      statuses: { pending: 1, approved: 1, rejected: 1, withdrawn: 1 },
      approvedAmount: amount,
    });
  expect(data.applications).not.toHaveProperty("approvedAmount");
  const text = JSON.stringify(data);
  for (const secret of [
    "统计私密标题",
    "不应暴露",
    "supplier",
    "applicant",
    "receipt",
    "linkedApplication",
    "routeSnapshot",
  ])
    expect(text).not.toContain(secret);
});

test("本人数据不因管理/财务/企业角色扩大；部门负责人仅当前部门聚合，不获正文权限", async () => {
  await approved("travel");
  await approved("travel", "colleague", "0.20");
  const outside = await submitted("travel", "outsider");
  await decision("travel", outside, 0, "reject", "other_head");
  expect((await stats()).applications.total).toBe(1);
  const department = await stats("?scope=department", "head");
  expect(department.filters.departmentId).toBe(departmentId);
  expect(group(department, "travel")).toMatchObject({
    total: 2,
    approvedAmount: "0.30",
  });
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'company_head')",
    [people.company.id],
  );
  for (const person of ["owner", "admin", "finance", "company"]) {
    expect((await request("?scope=department", person)).status).toBe(403);
  }
  for (const person of ["admin", "finance", "company", "head"])
    expect((await stats("", person)).applications.total).toBe(0);
  expect(
    (
      await request(
        `?scope=department&departmentId=${otherDepartmentId}`,
        "head",
      )
    ).status,
  ).toBe(403);
  expect(
    (await request(`?scope=department&departmentId=${randomUUID()}`, "head"))
      .status,
  ).toBe(403);
  expect(
    (await stats(`?scope=department&departmentId=${departmentId}`, "head"))
      .applications,
  ).toEqual(department.applications);
  expect(
    (
      await stats(
        `?scope=department&departmentId=${departmentId.toUpperCase()}`,
        "head",
      )
    ).applications,
  ).toEqual(department.applications);
  const { getTravelApplication } =
    await import("../src/server/travel-submission");
  await expect(
    getTravelApplication(people.head.token, outside.application.id),
  ).rejects.toMatchObject({ status: 404 });
});

test("新任部门负责人能读本部门汇总，但不因此获得未分配的历史正文", async () => {
  const old = await approved();
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code='department_head'",
    [people.head.id],
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'department_head')",
    [people.colleague.id],
  );
  expect(
    (await stats("?scope=department", "colleague")).applications.total,
  ).toBe(1);
  const { getTravelApplication } =
    await import("../src/server/travel-submission");
  await expect(
    getTravelApplication(people.colleague.token, old.application.id),
  ).rejects.toMatchObject({ status: 404 });
});

test("部门筛选只收窄本人历史；员工调部门不搬移已提交申请归属", async () => {
  await submitted();
  await database().query("UPDATE users SET department_id=$1 WHERE id=$2", [
    otherDepartmentId,
    people.owner.id,
  ]);
  await submitted();
  expect((await stats()).applications.total).toBe(2);
  expect(
    (await stats(`?departmentId=${departmentId}`)).applications.total,
  ).toBe(1);
  expect(
    (await stats(`?departmentId=${randomUUID()}`)).applications.total,
  ).toBe(0);
  expect((await stats("?scope=department", "head")).applications.total).toBe(1);
  expect(
    (await stats("?scope=department", "other_head")).applications.total,
  ).toBe(1);
});

test("实际待办独立于本人申请，后续/取消/已办排除，按申请提交时间而非激活时间过滤", async () => {
  const first = await submitted();
  const second = await submitted("purchase");
  const cancelled = await submitted("reimbursement");
  await withdraw.reimbursement(people.owner.token, cancelled.application.id, {
    version: cancelled.application.version,
    opinion: "",
  });
  await database().query(
    "UPDATE applications SET submitted_at='2028-02-28T16:00:00Z' WHERE id=ANY($1::uuid[])",
    [[first.application.id, second.application.id]],
  );
  const head = await stats("?from=2028-02-29&to=2028-02-29", "head");
  expect(head.applications.total).toBe(0);
  expect(head.pendingTasks.total).toBe(2);
  expect((await stats("", "finance")).pendingTasks.total).toBe(0);
  await decision("travel", first);
  expect((await stats("", "head")).pendingTasks.total).toBe(1);
  expect(
    (await stats("?from=2028-02-29&to=2028-02-29", "finance")).pendingTasks
      .total,
  ).toBe(1);
  expect((await stats("?type=purchase", "head")).pendingTasks).toEqual({
    total: 1,
    byType: [{ type: "purchase", count: 1 }],
  });
});

test("同人两节点只计当前实际待办一次；撤权不改已冻结任务，部门统计权限独立撤销", async () => {
  await database().query(
    "DELETE FROM user_roles WHERE role_code='finance_approver'",
  );
  await database().query(
    "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'finance_approver')",
    [people.head.id],
  );
  const first = await submitted();
  expect((await stats("", "head")).pendingTasks.total).toBe(1);
  const next = await decision("travel", first);
  expect((await stats("", "head")).pendingTasks.total).toBe(1);
  await database().query(
    "DELETE FROM user_roles WHERE user_id=$1 AND role_code IN ('department_head','finance_approver')",
    [people.head.id],
  );
  expect((await request("?scope=department", "head")).status).toBe(403);
  expect((await stats("", "head")).pendingTasks.total).toBe(1);
  await decision("travel", next, 1, "approve", "head");
  expect((await stats("", "head")).pendingTasks.total).toBe(0);
});

test("提交日上海边界包含首尾，闰日/单边范围/类型合法过滤，不按创建或批准日", async () => {
  const dates = [
    "2028-02-28T15:59:59.999Z",
    "2028-02-28T16:00:00Z",
    "2028-02-29T15:59:59.999Z",
    "2028-02-29T16:00:00Z",
  ];
  for (const date of dates) {
    const app = await approved();
    await database().query(
      "UPDATE applications SET submitted_at=$1 WHERE id=$2",
      [date, app.application.id],
    );
  }
  const data = await stats("?from=2028-02-29&to=2028-02-29&type=travel");
  expect(data.applications.byType).toHaveLength(1);
  expect(group(data, "travel")).toMatchObject({
    total: 2,
    approvedAmount: "0.20",
  });
  expect((await stats("?from=2028-02-29")).applications.total).toBe(3);
  expect((await stats("?to=2028-02-29")).applications.total).toBe(3);
  expect(
    (await stats("?from=9999-12-31&to=9999-12-31")).applications.total,
  ).toBe(0);
  expect(
    (await stats("?from=0001-01-01&to=0001-01-01")).applications.total,
  ).toBe(0);
  expect((await stats("?type=reimbursement")).applications.total).toBe(0);
});

test("精确合计超单据上限仍无舍入/溢出；采购金额非预算/报价，差旅允许零", async () => {
  await approved("travel", "owner", "0.00");
  await approved("purchase", "owner", "0.10");
  await approved("purchase", "owner", "0.20");
  for (let i = 0; i < 2; i++)
    await approved("reimbursement", "owner", "999999999999.99");
  const data = await stats();
  expect(group(data, "travel").approvedAmount).toBe("0.00");
  expect(group(data, "purchase").approvedAmount).toBe("0.30");
  expect(group(data, "reimbursement").approvedAmount).toBe("1999999999999.98");
});

test("未知金额不能默认为零；异常批准记录返回缺失计数和null", async () => {
  // Deliberate legacy/corrupt fixture, not a product path bypassing submission.
  const incomplete = await createPurchaseDraft(
    people.owner.token,
    purchaseDraftSchema.parse({ title: "缺失金额" }),
  );
  await database().query(
    "UPDATE applications SET status='approved',submitted_at=now() WHERE id=$1",
    [incomplete.id],
  );
  await approved("purchase");
  const data = await stats();
  expect(group(data, "purchase")).toMatchObject({
    total: 2,
    approvedAmount: null,
    approvedAmountMissingCount: 1,
  });
});

test("链接不产生重复采购/差旅合计；报销费用独立，草稿重提不计数", async () => {
  const travel = await approved();
  const purchase = await approved("purchase");
  const saved = await createReimbursementDraft(
    people.owner.token,
    reimbursementDraftSchema.parse({
      title: "关联报销",
      description: "关联",
      linkedApplicationIds: [travel.application.id, purchase.application.id],
      items: [
        {
          category: "transport",
          expenseDate: "2028-02-29",
          purpose: "费用",
          amount: "0.30",
          noReceipt: true,
          noReceiptReason: "遗失",
        },
      ],
    }),
  );
  const sent = await submit.reimbursement(people.owner.token, saved.id, 1);
  const terminal = await withdraw.reimbursement(people.owner.token, saved.id, {
    version: sent.application.version,
    opinion: "",
  });
  const copy = await copyReimbursementForResubmission(
    people.owner.token,
    saved.id,
    terminal.application.version,
  );
  expect((await stats()).applications.total).toBe(3);
  const retry = await submit.reimbursement(
    people.owner.token,
    copy.successor.id,
    1,
  );
  await decision("reimbursement", await decision("reimbursement", retry), 1);
  const data = await stats();
  expect(data.applications.total).toBe(4);
  expect(group(data, "travel").approvedAmount).toBe("0.10");
  expect(group(data, "purchase").approvedAmount).toBe("0.10");
  expect(group(data, "reimbursement")).toMatchObject({
    total: 2,
    approvedAmount: "0.30",
    statuses: { ...zero, approved: 1, withdrawn: 1 },
  });
});

test("非法/重复/未知查询严格拒绝，不能注入角色/申请人/状态或跨固定类型", async () => {
  for (const query of [
    "?scope=all",
    "?scope=department&scope=personal",
    "?type=custom",
    "?type=travel&type=purchase",
    "?departmentId=no",
    "?departmentId=",
    "?from=2027-02-29",
    "?from=0000-01-01",
    "?to=2028-02-30",
    "?from=2028-03-01&to=2028-02-29",
    "?from=2028-02-29T00:00:00Z",
    "?status=approved",
    "?userId=" + people.owner.id,
    "?role=department_head",
    "?page=1",
    "?__proto__=x",
    "?type=travel%27%20OR%201=1--",
  ]) {
    const response = await request(query);
    expect(response.status, query).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  }
});

test("Cookie与Bearer一致；匿名/失效/停用/待确认/无效部门拒绝", async () => {
  await submitted();
  const cookie = await statisticsHandler(
    new Request("http://localhost:3000/api/statistics", {
      headers: { Cookie: `approval_session=${people.owner.token}` },
    }),
  );
  expect((await cookie.json()).data).toEqual(await stats());
  expect((await request("", "")).status).toBe(401);
  expect((await request("", "pending")).status).toBe(403);
  await database().query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [people.owner.id],
  );
  expect((await request()).status).toBe(401);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.head.id],
  );
  expect((await request("?scope=department", "head")).status).toBe(401);
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    departmentId,
  ]);
  expect((await request("", "finance")).status).toBe(403);
});

test.each(["role", "session", "department"])(
  "等待组织锁后重新核验%s，不泄露旧权限统计",
  async (change) => {
    await submitted();
    const blocker = await database().connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(72002)");
      pending = request("?scope=department", "head");
      await expect
        .poll(
          async () =>
            (
              await blocker.query(
                "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=72002 AND NOT granted",
              )
            ).rows[0].n,
        )
        .toBeGreaterThan(0);
      if (change === "role")
        await blocker.query(
          "DELETE FROM user_roles WHERE user_id=$1 AND role_code='department_head'",
          [people.head.id],
        );
      if (change === "session")
        await blocker.query("DELETE FROM sessions WHERE user_id=$1", [
          people.head.id,
        ]);
      if (change === "department")
        await blocker.query("UPDATE users SET department_id=$1 WHERE id=$2", [
          otherDepartmentId,
          people.head.id,
        ]);
      await blocker.query("COMMIT");
      const response = await pending;
      if (change === "department") {
        expect(response.status).toBe(200);
        expect((await response.json()).data.applications.total).toBe(0);
      } else expect(response.status).toBe(change === "session" ? 401 : 403);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);

test("并发批准未提交时只见完整旧状态，提交后数量/金额/待办同时更新", async () => {
  const app = await submitted();
  const writer = await database().connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      "UPDATE applications SET status='approved',version=version+1 WHERE id=$1",
      [app.application.id],
    );
    await writer.query(
      "UPDATE approval_tasks SET status='approved',finished_at=now() WHERE id=$1",
      [app.tasks[0].id],
    );
    const old = await stats("?scope=department", "head");
    expect(group(old, "travel")).toMatchObject({
      total: 1,
      statuses: { ...zero, pending: 1 },
      approvedAmount: "0.00",
    });
    expect(old.pendingTasks.total).toBe(1);
    await writer.query("COMMIT");
    const current = await stats("?scope=department", "head");
    expect(group(current, "travel")).toMatchObject({
      total: 1,
      statuses: { ...zero, approved: 1 },
      approvedAmount: "0.10",
    });
    expect(current.pendingTasks.total).toBe(0);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});

test("查询不修改任何业务数据/通知，重复迁移与重建连接保持结果及索引", async () => {
  await approved("reimbursement");
  const snapshot = async () =>
    (
      await database().query(`SELECT jsonb_build_object(
    'applications',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM applications a),
    'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM approval_tasks t),
    'logs',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM approval_logs l),
    'notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n)) AS value`)
    ).rows[0].value;
  const before = await snapshot();
  const expected = await stats();
  await stats("?scope=department", "head");
  expect(await snapshot()).toEqual(before);
  await migrate();
  await migrate();
  await closeDatabase();
  expect(await stats()).toEqual(expected);
  expect(
    (
      await database().query(
        "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'applications_fixed_%_submitted_idx'",
      )
    ).rowCount,
  ).toBe(2);
  expect(
    await getFixedBusinessStatistics(
      people.owner.token,
      statisticsSchema.parse({}),
    ),
  ).toEqual(expected);
});
