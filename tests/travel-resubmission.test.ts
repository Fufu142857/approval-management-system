import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeAll, beforeEach, afterAll, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { travelDraftSchema, replaceTravelDraftSchema } from "../src/lib/travel";
import {
  createTravelDraft,
  getTravelDraft,
  replaceTravelDraft,
  deleteTravelDraft,
} from "../src/server/travel";
import {
  submitTravelDraft,
  getTravelApplication,
} from "../src/server/travel-submission";
import {
  decideTravelTask,
  withdrawTravelApplication,
} from "../src/server/travel-actions";
import {
  copyTravelForResubmission,
  getTravelResubmission,
} from "../src/server/travel-resubmission";
import {
  copyTravelHandler,
  travelResubmissionHandler,
} from "../src/server/travel-resubmission-handlers";
import {
  uploadTravelAttachment,
  listTravelAttachments,
  getTravelAttachmentContent,
} from "../src/server/travel-attachments";

const people: Record<string, { id: string; token: string }> = {};
const fields = travelDraftSchema.parse({
  title: "重提测试",
  departure: "杭州",
  destination: "上海",
  startDate: "2028-02-28",
  endDate: "2028-03-01",
  purpose: "业务交流",
  companions: "同行人员",
  transportation: "高铁",
  budget: "123.45",
  remarks: "完整备注",
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
    `http://localhost:3000/api/travel-applications/test/resubmission${search}`,
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
  const draft = await createTravelDraft(owner(), fields);
  let version = draft.version;
  if (withAttachment) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const file = await uploadTravelAttachment(
      owner(),
      draft.id,
      version,
      bytes,
      "原行程.png",
      "image/png",
    );
    version = file.version;
  }
  return submitTravelDraft(owner(), draft.id, version);
}
async function terminal(
  status: "rejected" | "withdrawn" = "withdrawn",
  withAttachment = false,
) {
  const value = await pending(withAttachment);
  return status === "withdrawn"
    ? withdrawTravelApplication(owner(), value.application.id, {
        version: value.application.version,
        opinion: "取消",
      })
    : decideTravelTask(
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
  copyTravelForResubmission(
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
  const files = await listTravelAttachments(owner(), original.application.id);
  const bytes = await getTravelAttachmentContent(
    owner(),
    original.application.id,
    files.items[0].id,
  );
  const result = await copy(original);
  expect(result.created).toBe(true);
  expect(result.successor.id).not.toBe(original.application.id);
  expect(result.successor.appNo).not.toBe(original.application.appNo);
  const draft = await getTravelDraft(owner(), result.successor.id);
  expect(draft).toMatchObject({
    ...fields,
    durationDays: 3,
    version: 1,
    status: "draft",
    submittedAt: null,
    resubmissionOf: original.application.id,
  });
  expect((await listTravelAttachments(owner(), draft.id)).items).toEqual([]);
  expect(await getTravelApplication(owner(), original.application.id)).toEqual(
    original,
  );
  expect(
    await getTravelAttachmentContent(
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
  const draft = await replaceTravelDraft(
    owner(),
    successor.id,
    replaceTravelDraftSchema.parse({
      ...fields,
      title: "修改后行程",
      budget: "234.56",
      version: 1,
    }),
  );
  const next = await submitTravelDraft(owner(), draft.id, draft.version);
  expect(next.application).toMatchObject({
    title: "修改后行程",
    budget: "234.56",
    resubmissionOf: original.application.id,
    status: "pending",
  });
  expect(next.workflow.id).not.toBe(original.workflow.id);
  expect(next.tasks.map((task) => task.status)).toEqual(["pending", "blocked"]);
  expect(next.logs).toHaveLength(1);
  expect(await getTravelApplication(owner(), original.application.id)).toEqual(
    original,
  );
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
        ? await createTravelDraft(owner(), fields)
        : (await pending()).application;
    if (state === "approved") {
      let value = await getTravelApplication(owner(), app.id);
      value = await decideTravelTask(
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
        await decideTravelTask(
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
        await copyTravelHandler(
          req("POST", { version: app.version }),
          ctx(app.id),
        )
      ).status,
    ).toBe(409);
    expect((await travelResubmissionHandler(req(), ctx(app.id))).status).toBe(
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
        await copyTravelHandler(
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
        await travelResubmissionHandler(
          req("GET", undefined, people[name].token),
          ctx(original.application.id),
        )
      ).status,
    ).toBe(code);
  }
  expect(
    (
      await copyTravelHandler(
        req("POST", { version: original.application.version }, "", "", {
          Origin: "http://localhost:3000",
        }),
        ctx(original.application.id),
      )
    ).status,
  ).toBe(401);
  expect(
    (await copyTravelHandler(req("POST", { version: 1 }), ctx(randomUUID())))
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
    expect((await copyTravelHandler(req("POST", body), ctx(id))).status).toBe(
      400,
    );
  expect(
    (
      await copyTravelHandler(
        req("POST", { version }, owner(), "?x=1"),
        ctx(id),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await travelResubmissionHandler(
        req("GET", undefined, owner(), "?x=1&x=2"),
        ctx(id),
      )
    ).status,
  ).toBe(400);
  expect(
    (await copyTravelHandler(req("POST", { version }), ctx("bad-id"))).status,
  ).toBe(400);
  expect(
    (
      await copyTravelHandler(
        req("POST", { version }, "", "", {
          Cookie: `approval_session=${owner()}`,
        }),
        ctx(id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await copyTravelHandler(
        req("POST", { version }, owner(), "", {
          Origin: "https://other.invalid",
        }),
        ctx(id),
      )
    ).status,
  ).toBe(403);
  expect((await getTravelResubmission(owner(), id)).successor).toBeNull();
});

test("原版本不匹配拒绝，已有后续草稿也不能绕过版本校验", async () => {
  const value = await terminal();
  for (const withChild of [false, true]) {
    if (withChild) await copy(value);
    const response = await copyTravelHandler(
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
      copyTravelHandler(
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
  await replaceTravelDraft(
    owner(),
    id,
    replaceTravelDraftSchema.parse({
      ...fields,
      title: "用户修改",
      version: 1,
    }),
  );
  expect((await copy(value)).successor).toMatchObject({ id, version: 2 });
  expect((await getTravelDraft(owner(), id)).title).toBe("用户修改");
});

test("删除未提交后续草稿可重建，再次终态沿链重提不覆盖旧链", async () => {
  const value = await terminal();
  const first = await copy(value);
  await deleteTravelDraft(owner(), first.successor.id, 1);
  expect(
    (await getTravelResubmission(owner(), value.application.id)).successor,
  ).toBeNull();
  const second = await copy(value);
  expect(second.successor.id).not.toBe(first.successor.id);
  const sent = await submitTravelDraft(owner(), second.successor.id, 1);
  const cancelled = await withdrawTravelApplication(
    owner(),
    sent.application.id,
    { version: sent.application.version, opinion: "" },
  );
  const third = await copy(cancelled);
  expect(
    (await getTravelDraft(owner(), third.successor.id)).resubmissionOf,
  ).toBe(second.successor.id);
  expect((await copy(value)).successor.id).toBe(second.successor.id);
  expect(await getTravelApplication(owner(), value.application.id)).toEqual(
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
      "INSERT INTO applications(applicant_id,department_id,resubmission_of) SELECT $1,department_id,$2 FROM users WHERE id=$1",
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

test("明细插入故障回滚新主表与关联，原业务记录不变", async () => {
  const value = await terminal();
  const before = await counts();
  await database().query(
    `CREATE FUNCTION fail_resubmission_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_resubmission_test BEFORE INSERT ON travel_requests FOR EACH ROW EXECUTE FUNCTION fail_resubmission_test()`,
  );
  try {
    await expect(copy(value)).rejects.toThrow();
  } finally {
    await database().query(
      "DROP TRIGGER fail_resubmission_test ON travel_requests; DROP FUNCTION fail_resubmission_test()",
    );
  }
  expect(await counts()).toEqual(before);
  expect(
    (await getTravelResubmission(owner(), value.application.id)).successor,
  ).toBeNull();
  expect(await getTravelApplication(owner(), value.application.id)).toEqual(
    value,
  );
});

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
  expect((await getTravelDraft(owner(), child.id)).departmentId).toBe(
    department,
  );
  const sent = await submitTravelDraft(owner(), child.id, 1);
  expect(sent.tasks[0].approverId).toBe(people.other.id);
  await expect(
    getTravelApplication(people.head.token, child.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    getTravelApplication(people.other.token, value.application.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(await getTravelApplication(owner(), value.application.id)).toEqual(
    value,
  );
});

test("重复迁移与连接重建保留来源及后续链接", async () => {
  const value = await terminal();
  await copy(value);
  const before = await getTravelResubmission(owner(), value.application.id);
  await migrate();
  await closeDatabase();
  expect(await getTravelResubmission(owner(), value.application.id)).toEqual(
    before,
  );
});
