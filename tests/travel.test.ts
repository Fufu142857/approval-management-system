import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  createTravelDraftHandler as create,
  listTravelDraftsHandler as list,
  getTravelDraftHandler as get,
  replaceTravelDraftHandler as replace,
  deleteTravelDraftHandler as remove,
} from "../src/server/travel-handlers";

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
  return new Request(`${origin}/api/travel-drafts${suffix}`, {
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
  title: "市场调研",
  departure: "杭州",
  destination: "上海",
  startDate: "2028-02-28",
  endDate: "2028-03-01",
  purpose: "客户交流",
  companions: "张三、李四",
  transportation: "高铁",
  budget: "1000.10",
  remarks: "携带资料",
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

test("可保存未填完的草稿，编号/身份/时间由服务端确定且重复迁移保留数据", async () => {
  const saved = await draft({ title: "  未完成  " });
  expect(saved).toMatchObject({
    title: "未完成",
    applicantId: ownerId,
    departmentId,
    type: "travel",
    status: "draft",
    version: 1,
    departure: "",
    startDate: null,
    endDate: null,
    budget: null,
    durationDays: null,
    submittedAt: null,
  });
  expect(saved.appNo).toMatch(/^APP-[1-9]\d*$/);
  expect(Number.isFinite(Date.parse(saved.createdAt))).toBe(true);
  await migrate();
  await closeDatabase();
  expect((await (await get(request(), context(saved.id))).json()).data).toEqual(
    saved,
  );
  expect(
    (await database().query("SELECT count(*)::int AS n FROM travel_requests"))
      .rows[0].n,
  ).toBe(1);
});

test("预算精确保存零、小数及最大金额；自然日含首尾且正确跨闰日和年界", async () => {
  for (const [startDate, endDate, days, input, output] of [
    ["2028-02-28", "2028-03-01", 3, "1000.10", "1000.10"],
    ["2027-02-28", "2027-03-01", 2, "0", "0.00"],
    ["2026-12-31", "2027-01-01", 2, "999999999999.99", "999999999999.99"],
    ["2026-10-16", "2026-10-16", 1, "0.1", "0.10"],
    ["0001-01-01", "0001-01-01", 1, "1.01", "1.01"],
  ]) {
    const saved = await draft({ ...fields, startDate, endDate, budget: input });
    expect(saved).toMatchObject({
      startDate,
      endDate,
      budget: output,
      durationDays: days,
    });
  }
  expect((await draft({ startDate: "2026-10-16" })).durationDays).toBeNull();
});

test("拒绝负数、溢出、指数/浮点输入、无效日期与倒置日期且没有半条记录", async () => {
  for (const budget of [
    "-0.01",
    "1000000000000.00",
    "0.001",
    "1e2",
    "NaN",
    "Infinity",
    "01.00",
    " 1 ",
    "",
    1.2,
  ]) {
    expect((await create(request("POST", { ...fields, budget }))).status).toBe(
      400,
    );
  }
  for (const extra of [
    { startDate: "2027-02-29" },
    { startDate: "2026-04-31" },
    { startDate: "0000-01-01" },
    { endDate: "2028-02-27" },
    { startDate: "2026-10-16T12:00:00+08:00" },
    { startDate: "2026-1-1" },
    { endDate: "" },
    { title: "x".repeat(201) },
  ])
    expect(
      (await create(request("POST", { ...fields, ...extra }))).status,
    ).toBe(400);
  for (const table of ["applications", "travel_requests"]) {
    expect(
      (await database().query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n,
    ).toBe(0);
  }
});

test("严格白名单拒绝身份、状态、编号、时长、审批配置与未知字段注入", async () => {
  const saved = await draft();
  for (const key of [
    "applicantId",
    "departmentId",
    "status",
    "appNo",
    "durationDays",
    "createdAt",
    "submittedAt",
    "type",
    "approverId",
    "processVersionId",
    "attachments",
  ]) {
    const extra = { [key]: "forged" };
    expect(
      (await create(request("POST", { ...fields, ...extra }))).status,
    ).toBe(400);
    expect(
      (
        await replace(
          request("PUT", { ...fields, version: 1, ...extra }),
          context(saved.id),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (await replace(request("PUT", fields), context(saved.id))).status,
  ).toBe(400);
  expect((await remove(request("DELETE", {}), context(saved.id))).status).toBe(
    400,
  );
  expect((await get(request(), context("bad-id"))).status).toBe(400);
});

test("未登录、待确认、停用/过期会话与停用部门不能访问任何草稿操作", async () => {
  const saved = await draft();
  async function allDenied(token: string, status: number) {
    const responses = [
      await create(request("POST", {}, token)),
      await list(request("GET", undefined, token)),
      await get(request("GET", undefined, token), context(saved.id)),
      await replace(request("PUT", { version: 1 }, token), context(saved.id)),
      await remove(request("DELETE", { version: 1 }, token), context(saved.id)),
    ];
    expect(responses.map((r) => r.status)).toEqual(Array(5).fill(status));
  }
  // Bearer-shaped invalid credentials exercise authentication without the Cookie Origin guard.
  await allDenied("0".repeat(64), 401);
  await allDenied(pendingToken, 403);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [ownerId],
  );
  await allDenied(ownerToken, 401);
  await database().query(
    "UPDATE users SET registration_status='active' WHERE id=$1",
    [ownerId],
  );
  await database().query("UPDATE departments SET active=false WHERE id=$1", [
    departmentId,
  ]);
  await allDenied(ownerToken, 403);
  await database().query("UPDATE departments SET active=true WHERE id=$1", [
    departmentId,
  ]);
  await database().query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [tokenHash(ownerToken)],
  );
  await allDenied(ownerToken, 401);
});

test("同部门负责人和系统管理员也不能读取、改写或删除他人草稿", async () => {
  const saved = await draft();
  for (const token of [otherToken, adminToken]) {
    expect(
      (await (await list(request("GET", undefined, token))).json()).data,
    ).toMatchObject({ items: [], total: 0 });
    expect(
      (await get(request("GET", undefined, token), context(saved.id))).status,
    ).toBe(404);
    expect(
      (await replace(request("PUT", { version: 1 }, token), context(saved.id)))
        .status,
    ).toBe(404);
    expect(
      (
        await remove(
          request("DELETE", { version: 1 }, token),
          context(saved.id),
        )
      ).status,
    ).toBe(404);
  }
  expect((await get(request(), context(randomUUID()))).status).toBe(404);
  expect((await (await get(request(), context(saved.id))).json()).data).toEqual(
    saved,
  );
});

test("完整保存重算天数并刷新部门/版本；缺省字段清空；删除需当前版本", async () => {
  const saved = await draft();
  const nextDepartment = (
    await database().query("SELECT id FROM departments WHERE id<>$1 LIMIT 1", [
      departmentId,
    ])
  ).rows[0].id;
  await database().query("UPDATE users SET department_id=$2 WHERE id=$1", [
    ownerId,
    nextDepartment,
  ]);
  const response = await replace(
    request("PUT", {
      title: "新标题",
      startDate: "2026-10-16",
      endDate: "2026-10-20",
      budget: "0.01",
      version: 1,
    }),
    context(saved.id),
  );
  expect(response.status).toBe(200);
  const updated = (await response.json()).data;
  expect(updated).toMatchObject({
    id: saved.id,
    appNo: saved.appNo,
    createdAt: saved.createdAt,
    departmentId: nextDepartment,
    title: "新标题",
    departure: "",
    purpose: "",
    budget: "0.01",
    durationDays: 5,
    version: 2,
  });
  expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(
    Date.parse(saved.updatedAt),
  );
  expect(
    (await remove(request("DELETE", { version: 1 }), context(saved.id))).status,
  ).toBe(409);
  expect(
    (await remove(request("DELETE", { version: 2 }), context(saved.id))).status,
  ).toBe(200);
  expect((await get(request(), context(saved.id))).status).toBe(404);
  expect(
    (await database().query("SELECT count(*)::int AS n FROM travel_requests"))
      .rows[0].n,
  ).toBe(0);
  expect((await draft()).appNo).not.toBe(saved.appNo);
});

test("所有非草稿状态拒绝草稿操作，列表不泄露已提交内容", async () => {
  for (const status of ["pending", "approved", "rejected", "withdrawn"]) {
    const saved = await draft();
    // Database fixture only: no submit or approval API exists in S3a.
    await database().query(
      "UPDATE applications SET status=$2,submitted_at=now() WHERE id=$1",
      [saved.id, status],
    );
    expect((await get(request(), context(saved.id))).status).toBe(409);
    expect(
      (await replace(request("PUT", { version: 1 }), context(saved.id))).status,
    ).toBe(409);
    expect(
      (await remove(request("DELETE", { version: 1 }), context(saved.id)))
        .status,
    ).toBe(409);
    expect(
      (
        await database().query("SELECT status FROM applications WHERE id=$1", [
          saved.id,
        ])
      ).rows[0].status,
    ).toBe(status);
  }
  expect((await (await list(request())).json()).data.total).toBe(0);
});

test("本人列表稳定分页、空页保留总数，标题/编号搜索按字面处理通配符", async () => {
  const first = await draft({ title: "Travel_100%" });
  await draft({ title: "Travel other" });
  await draft({ title: "第三项" });
  const result = await list(
    request("GET", undefined, ownerToken, "?pageSize=1&page=2"),
  );
  expect((await result.json()).data).toMatchObject({
    total: 3,
    page: 2,
    pageSize: 1,
    items: [{ title: "Travel other" }],
  });
  expect(
    (
      await (
        await list(request("GET", undefined, ownerToken, "?page=9&pageSize=1"))
      ).json()
    ).data,
  ).toMatchObject({ total: 3, items: [] });
  for (const keyword of ["travel_100%", first.appNo]) {
    const filtered = await list(
      request(
        "GET",
        undefined,
        ownerToken,
        `?keyword=${encodeURIComponent(keyword)}`,
      ),
    );
    expect((await filtered.json()).data).toMatchObject({
      total: 1,
      items: [{ id: first.id }],
    });
  }
  for (const query of [
    "?page=0",
    "?pageSize=101",
    "?applicantId=forged",
    "?status=pending",
  ]) {
    expect(
      (await list(request("GET", undefined, ownerToken, query))).status,
    ).toBe(400);
  }
});

test("并发创建有唯一编号，并发同版本保存仅一次成功", async () => {
  const created = await Promise.all(Array.from({ length: 8 }, () => draft()));
  expect(new Set(created.map((item) => item.appNo)).size).toBe(8);
  const saved = created[0];
  const responses = await Promise.all(
    ["A", "B"].map((value) =>
      replace(
        request("PUT", {
          ...fields,
          title: value,
          destination: value,
          version: 1,
        }),
        context(saved.id),
      ),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = (await responses.find((r) => r.status === 200)!.json()).data;
  const actual = (await (await get(request(), context(saved.id))).json()).data;
  expect(actual).toEqual(winner);
  expect(actual.version).toBe(2);
  expect(actual.title).toBe(actual.destination);
});

test("同版本保存与删除竞争只有一方成功，不留孤立明细", async () => {
  const saved = await draft();
  const responses = await Promise.all([
    replace(request("PUT", { ...fields, version: 1 }), context(saved.id)),
    remove(request("DELETE", { version: 1 }), context(saved.id)),
  ]);
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  expect([404, 409]).toContain(responses.find((r) => r.status !== 200)!.status);
  const counts = (
    await database().query(
      "SELECT (SELECT count(*) FROM applications) AS apps,(SELECT count(*) FROM travel_requests) AS details",
    )
  ).rows[0];
  expect(counts.apps).toBe(counts.details);
});

test("明细写入失败时创建和更新均回滚，包括主表内容与版本", async () => {
  const saved = await draft();
  await database().query(
    "ALTER TABLE travel_requests ADD CONSTRAINT test_fail_travel CHECK (destination<>'ROLLBACK')",
  );
  try {
    expect(
      (await create(request("POST", { ...fields, destination: "ROLLBACK" })))
        .status,
    ).toBe(500);
    expect(
      (
        await replace(
          request("PUT", {
            ...fields,
            title: "不应保存",
            destination: "ROLLBACK",
            version: 1,
          }),
          context(saved.id),
        )
      ).status,
    ).toBe(500);
    expect(
      (await (await get(request(), context(saved.id))).json()).data,
    ).toEqual(saved);
    expect(
      (await database().query("SELECT count(*)::int AS n FROM applications"))
        .rows[0].n,
    ).toBe(1);
  } finally {
    await database().query(
      "ALTER TABLE travel_requests DROP CONSTRAINT test_fail_travel",
    );
  }
});

test("主表删除失败会恢复已删明细；用户和部门引用限制物理删除", async () => {
  const saved = await draft();
  await database().query(
    "CREATE TABLE test_draft_reference(app_id UUID REFERENCES applications(id) ON DELETE RESTRICT)",
  );
  try {
    await database().query("INSERT INTO test_draft_reference VALUES ($1)", [
      saved.id,
    ]);
    expect(
      (await remove(request("DELETE", { version: 1 }), context(saved.id)))
        .status,
    ).toBe(500);
    expect(
      (await (await get(request(), context(saved.id))).json()).data,
    ).toEqual(saved);
    await expect(
      database().query("DELETE FROM users WHERE id=$1", [ownerId]),
    ).rejects.toMatchObject({ code: "23503" });
  } finally {
    await database().query("DROP TABLE test_draft_reference");
  }
});

test("等待组织变更锁后重新鉴权，先完成停用的旧会话不能写入草稿", async () => {
  const client = await database().connect();
  let pending: Promise<Response> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72002)");
    pending = create(request("POST", fields));
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
      "UPDATE users SET registration_status='disabled' WHERE id=$1",
      [ownerId],
    );
    await client.query("DELETE FROM sessions WHERE user_id=$1", [ownerId]);
    await client.query("COMMIT");
    expect((await pending).status).toBe(401);
    expect(
      (await database().query("SELECT count(*)::int AS n FROM applications"))
        .rows[0].n,
    ).toBe(0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pending;
  }
});

test("Cookie 写入须同源，跨站和过大/错误正文被拒绝", async () => {
  const cookie = { Cookie: `approval_session=${ownerToken}` };
  expect((await create(request("POST", {}, "", "", cookie))).status).toBe(403);
  expect(
    (
      await create(
        request("POST", {}, "", "", {
          ...cookie,
          Origin: "https://example.invalid",
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await create(request("POST", {}, "", "", { ...cookie, Origin: origin })))
      .status,
  ).toBe(201);
  expect(
    (await create(request("POST", { purpose: "x".repeat(17000) }))).status,
  ).toBe(413);
  expect(
    (
      await create(
        request("POST", {}, ownerToken, "", { "Content-Type": "text/plain" }),
      )
    ).status,
  ).toBe(415);
});
