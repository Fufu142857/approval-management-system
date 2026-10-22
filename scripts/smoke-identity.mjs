import { resolve } from "node:path";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { Pool } from "pg";
import { loadEnvFile } from "node:process";
import sharp from "sharp";
loadEnvFile(".env");
process.env.ATTACHMENT_STORAGE_DIR = resolve("tmp/attachments-http-test");
assert(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test"));
execFileSync(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "scripts/database.ts", "migrate"],
  {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  },
);
// Build our own fixture: other test files deliberately exercise a different admin password.
const fixture = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
await fixture.query(
  "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
);
await fixture.end();
execFileSync(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "scripts/database.ts", "seed"],
  {
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      ADMIN_INITIAL_PASSWORD: "Test-user-password",
    },
  },
);
const origin = "http://127.0.0.1:3100";
let output = "";
function startServer() {
  output = "";
  const child = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        APP_ORIGIN: origin,
        SESSION_COOKIE_SECURE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const closed = new Promise((resolve) => child.on("close", resolve));
  return { child, closed };
}
let server = startServer();
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (server.child.exitCode !== null)
      throw new Error("Test server exited: " + output);
    if (output.includes("Ready")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not become ready");
}
async function call(path, method = "GET", body, token, cookie) {
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { response, body: await response.json() };
}
try {
  await ready();
  const departments = await call("departments");
  assert.equal(departments.response.status, 200);
  const departmentId = departments.body.data[0].id;
  const username = `smoke_${Date.now()}`;
  const password = "Test-user-password";
  const registration = await call("auth/register", "POST", {
    username,
    fullName: "HTTP 验收",
    email: `${username}@example.invalid`,
    password,
    requestedDepartmentId: departmentId,
  });
  assert.equal(registration.response.status, 201);
  const id = registration.body.data.id;
  const login = await call("auth/login", "POST", {
    username,
    password,
    client: "mobile",
  });
  assert.equal(login.response.status, 200);
  const oldToken = login.body.data.token;
  assert.equal(
    (await call("auth/me", "GET", undefined, oldToken)).body.data.status,
    "pending",
  );
  const admin = await call("auth/login", "POST", {
    username: "admin",
    password,
  });
  assert.equal(admin.response.status, 200);
  const cookie = admin.response.headers.get("set-cookie").split(";")[0];
  assert.equal(admin.body.data.token, undefined);
  const change = await call(
    `admin/users/${id}/access`,
    "PATCH",
    {
      departmentId,
      status: "active",
      roles: ["employee"],
      reason: "生产 HTTP 接口验收",
    },
    undefined,
    cookie,
  );
  assert.equal(change.response.status, 200);
  assert.equal(
    (await call("auth/me", "GET", undefined, oldToken)).response.status,
    401,
  );
  const renewed = await call("auth/login", "POST", {
    username,
    password,
    client: "mobile",
  });
  const token = renewed.body.data.token;
  assert.equal(
    (await call("auth/me", "GET", undefined, token)).body.data.status,
    "active",
  );
  assert.equal(
    (await call("admin/users", "GET", undefined, token)).response.status,
    403,
  );
  assert.equal(
    (await call("admin/audit-logs", "GET", undefined, undefined, cookie))
      .response.status,
    200,
  );
  const travel = {
    title: "HTTP 差旅草稿",
    departure: "杭州",
    destination: "上海",
    startDate: "2028-02-28",
    endDate: "2028-03-01",
    purpose: "客户交流",
    companions: "",
    transportation: "高铁",
    budget: "1234.56",
  };
  const created = await call("travel-drafts", "POST", travel, token);
  assert.equal(created.response.status, 201);
  const saved = created.body.data;
  assert.equal(saved.applicantId, id);
  assert.equal(saved.durationDays, 3);
  assert.equal(saved.budget, "1234.56");
  assert.match(saved.appNo, /^APP-[1-9]\d*$/);
  const path = `travel-drafts/${saved.id}`;
  assert.equal(
    (await call(path, "GET", undefined, undefined, cookie)).response.status,
    404,
  );
  assert.equal(
    (await call("travel-drafts", "GET", undefined, token)).body.data.total,
    1,
  );
  // Restart the actual production process without resetting the database or sessions.
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
  assert.deepEqual(
    (await call(path, "GET", undefined, token)).body.data,
    saved,
  );
  const changed = await call(
    path,
    "PUT",
    { ...travel, budget: "0.01", version: 1 },
    token,
  );
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.data.version, 2);
  assert.equal(changed.body.data.budget, "0.01");
  assert.equal(
    (await call(path, "PUT", { ...travel, version: 1 }, token)).response.status,
    409,
  );
  assert.equal(
    (await call(path, "DELETE", { version: 1 }, token)).response.status,
    409,
  );
  assert.equal(
    (await call(path, "DELETE", { version: 2 }, token)).response.status,
    200,
  );
  assert.equal(
    (await call(path, "GET", undefined, token)).response.status,
    404,
  );
  async function approver(label, role, approverDepartmentId) {
    const approverUsername = `smoke_${label}_${Date.now()}`;
    const registered = await call("auth/register", "POST", {
      username: approverUsername,
      fullName: `HTTP ${label}`,
      email: `${approverUsername}@example.invalid`,
      password,
      requestedDepartmentId: approverDepartmentId,
    });
    assert.equal(registered.response.status, 201);
    const authorized = await call(
      `admin/users/${registered.body.data.id}/access`,
      "PATCH",
      {
        departmentId: approverDepartmentId,
        status: "active",
        roles: ["employee", role],
        reason: "生产 HTTP 固定差旅提交验收",
      },
      undefined,
      cookie,
    );
    assert.equal(authorized.response.status, 200);
    const loggedIn = await call("auth/login", "POST", {
      username: approverUsername,
      password,
      client: "mobile",
    });
    assert.equal(loggedIn.response.status, 200);
    return { id: registered.body.data.id, token: loggedIn.body.data.token };
  }
  const head = await approver("head", "department_head", departmentId);
  const financeDepartment = departments.body.data.find(
    (d) => d.name === "财务部",
  );
  assert(financeDepartment);
  const finance = await approver(
    "finance",
    "finance_approver",
    financeDepartment.id,
  );
  const toSubmit = await call("travel-drafts", "POST", travel, token);
  assert.equal(toSubmit.response.status, 201);
  const submitPath = `travel-drafts/${toSubmit.body.data.id}/submit`;
  const submitted = await call(submitPath, "POST", { version: 1 }, token);
  assert.equal(submitted.response.status, 200);
  const detail = submitted.body.data;
  assert.equal(detail.application.status, "pending");
  assert.equal(detail.application.version, 2);
  assert.equal(detail.workflow.ruleVersion, "fixed-travel-v1");
  assert.deepEqual(
    detail.tasks.map((task) => [task.approverId, task.status]),
    [
      [head.id, "pending"],
      [finance.id, "blocked"],
    ],
  );
  assert.equal(detail.logs.length, 1);
  assert.equal(detail.logs[0].action, "submitted");
  assert.equal(
    (await call(submitPath, "POST", { version: 1 }, token)).response.status,
    409,
  );
  const ownedPending = await call(
    "travel-applications?type=travel&status=pending",
    "GET",
    undefined,
    token,
  );
  assert.equal(ownedPending.response.status, 200);
  assert.equal(ownedPending.body.data.total, 1);
  assert.equal(
    ownedPending.body.data.items[0].currentTask.id,
    detail.tasks[0].id,
  );
  assert.equal(
    (await call("travel-tasks", "GET", undefined, head.token)).body.data
      .items[0].id,
    detail.tasks[0].id,
  );
  assert.equal(
    (await call("travel-tasks", "GET", undefined, finance.token)).body.data
      .total,
    0,
  );
  assert.equal(
    (await call("travel-applications", "GET", undefined, undefined, cookie))
      .body.data.total,
    0,
  );
  assert.equal(
    (await call("travel-tasks", "GET", undefined, undefined, cookie)).body.data
      .total,
    0,
  );
  assert.equal((await call("travel-applications")).response.status, 401);
  assert.equal(
    (await call("travel-tasks?approverId=" + head.id, "GET", undefined, token))
      .response.status,
    400,
  );
  assert.equal(
    (
      await call(
        "travel-applications?from=2026-12-01&to=2026-11-01",
        "GET",
        undefined,
        token,
      )
    ).response.status,
    400,
  );
  const detailPath = `travel-applications/${detail.application.id}`;
  assert.equal(
    (await call(detailPath, "GET", undefined, head.token)).response.status,
    200,
  );
  assert.equal(
    (await call(detailPath, "GET", undefined, finance.token)).response.status,
    404,
  );
  assert.equal(
    (await call(detailPath, "GET", undefined, undefined, cookie)).response
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        `travel-drafts/${detail.application.id}`,
        "DELETE",
        { version: 2 },
        token,
      )
    ).response.status,
    409,
  );
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
  assert.deepEqual(
    (await call(detailPath, "GET", undefined, token)).body.data,
    detail,
  );
  assert.equal(
    (await call(detailPath, "GET", undefined, head.token)).response.status,
    200,
  );
  // Check event-key persistence directly in the isolated test database as well.
  const persisted = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  try {
    const notices = await persisted.query(
      "SELECT recipient_id,event_key FROM notifications WHERE app_id=$1",
      [detail.application.id],
    );
    assert.deepEqual(notices.rows, [
      {
        recipient_id: head.id,
        event_key: `task:${detail.tasks[0].id}:pending`,
      },
    ]);
  } finally {
    await persisted.end();
  }
  const decisionPath = (value, index) =>
    `travel-applications/${value.application.id}/tasks/${value.tasks[index].id}/decision`;
  assert.equal(
    (
      await call(
        decisionPath(detail, 1),
        "POST",
        { version: 2, decision: "approve" },
        finance.token,
      )
    ).response.status,
    409,
  );
  const firstDecision = await call(
    decisionPath(detail, 0),
    "POST",
    { version: 2, decision: "approve", opinion: "同意" },
    head.token,
  );
  assert.equal(firstDecision.response.status, 200);
  assert.equal(firstDecision.body.data.application.version, 3);
  assert.equal(
    (await call(detailPath, "GET", undefined, head.token)).response.status,
    200,
  );
  const finalDecision = await call(
    decisionPath(detail, 1),
    "POST",
    { version: 3, decision: "approve" },
    finance.token,
  );
  assert.equal(finalDecision.response.status, 200);
  assert.equal(finalDecision.body.data.application.status, "approved");
  assert.equal(finalDecision.body.data.logs.length, 3);
  assert.equal(
    (
      await call(
        decisionPath(detail, 1),
        "POST",
        { version: 3, decision: "approve" },
        finance.token,
      )
    ).response.status,
    409,
  );
  async function submittedTravel() {
    const saved = await call("travel-drafts", "POST", travel, token);
    assert.equal(saved.response.status, 201);
    const result = await call(
      `travel-drafts/${saved.body.data.id}/submit`,
      "POST",
      { version: 1 },
      token,
    );
    assert.equal(result.response.status, 200);
    return result.body.data;
  }
  const rejectedTravel = await submittedTravel();
  assert.equal(
    (
      await call(
        decisionPath(rejectedTravel, 0),
        "POST",
        { version: 2, decision: "reject", opinion: " " },
        head.token,
      )
    ).response.status,
    400,
  );
  const rejection = await call(
    decisionPath(rejectedTravel, 0),
    "POST",
    { version: 2, decision: "reject", opinion: "请补充行程" },
    head.token,
  );
  assert.equal(rejection.response.status, 200);
  assert.equal(rejection.body.data.application.status, "rejected");
  const withdrawnTravel = await submittedTravel();
  const withdrawalPath = `travel-applications/${withdrawnTravel.application.id}/withdraw`;
  const withdrawal = await call(
    withdrawalPath,
    "POST",
    { version: 2, opinion: "行程取消" },
    token,
  );
  assert.equal(withdrawal.response.status, 200);
  assert.equal(withdrawal.body.data.application.status, "withdrawn");
  assert.equal(
    (await call(withdrawalPath, "POST", { version: 2 }, token)).response.status,
    409,
  );
  assert.equal(
    (
      await call(
        `travel-applications/${withdrawnTravel.application.id}`,
        "GET",
        undefined,
        finance.token,
      )
    ).response.status,
    404,
  );
  const ownedTerminal = (
    await call("travel-applications", "GET", undefined, token)
  ).body.data;
  assert.deepEqual(ownedTerminal.items.map((item) => item.status).sort(), [
    "approved",
    "rejected",
    "withdrawn",
  ]);
  const headHandled = (
    await call("travel-tasks?state=handled", "GET", undefined, head.token)
  ).body.data;
  assert.equal(headHandled.total, 2);
  assert.deepEqual(headHandled.items.map((item) => item.status).sort(), [
    "approved",
    "rejected",
  ]);
  assert.equal(
    (await call("travel-tasks", "GET", undefined, head.token)).body.data.total,
    0,
  );
  const filteredLists = (
    await call(
      "travel-applications?status=approved&pageSize=1&page=2",
      "GET",
      undefined,
      token,
    )
  ).body.data;
  assert.equal(filteredLists.total, 1);
  assert.deepEqual(filteredLists.items, []);
  assert.equal(
    (
      await call(
        "travel-applications?keyword=" + detail.application.appNo.toLowerCase(),
        "GET",
        undefined,
        token,
      )
    ).body.data.total,
    1,
  );
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
  assert.deepEqual(
    (await call("travel-applications", "GET", undefined, token)).body.data,
    ownedTerminal,
  );
  assert.deepEqual(
    (await call("travel-tasks?state=handled", "GET", undefined, head.token))
      .body.data,
    headHandled,
  );
  for (const result of [finalDecision, rejection, withdrawal]) {
    const resultPath = `travel-applications/${result.body.data.application.id}`;
    assert.deepEqual(
      (await call(resultPath, "GET", undefined, token)).body.data,
      result.body.data,
    );
    assert.equal(
      (await call(resultPath, "GET", undefined, head.token)).response.status,
      200,
    );
  }
  const terminalRecords = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  try {
    const counts = await terminalRecords.query(
      "SELECT kind,count(*)::int AS count FROM notifications WHERE kind<>'approval.pending' GROUP BY kind ORDER BY kind",
    );
    assert.deepEqual(counts.rows, [
      { kind: "application.approved", count: 1 },
      { kind: "application.rejected", count: 1 },
      { kind: "application.withdrawn", count: 2 },
    ]);
  } finally {
    await terminalRecords.end();
  }
  const inbox = await call("notifications", "GET", undefined, head.token);
  assert.equal(inbox.response.status, 200);
  assert.equal(inbox.body.data.total, 4);
  assert.equal(inbox.body.data.unreadCount, 4);
  const oldTaskNotice = inbox.body.data.items.find(
    (item) => item.appId === detail.application.id,
  );
  assert(oldTaskNotice);
  assert.equal(oldTaskNotice.task.status, "approved");
  assert.equal(oldTaskNotice.target.status, "approved");
  assert.equal(
    (
      await call(
        oldTaskNotice.target.apiPath.slice(5),
        "GET",
        undefined,
        head.token,
      )
    ).response.status,
    200,
  );
  const noticePath = `notifications/${oldTaskNotice.id}`;
  assert.equal(
    (await call(noticePath, "GET", undefined, token)).response.status,
    404,
  );
  assert.equal(
    (await call(`${noticePath}/read`, "POST", {}, undefined, cookie)).response
      .status,
    404,
  );
  const readResults = await Promise.all([
    call(`${noticePath}/read`, "POST", {}, head.token),
    call(`${noticePath}/read`, "POST", {}, head.token),
  ]);
  for (const result of readResults) assert.equal(result.response.status, 200);
  assert.deepEqual(readResults[0].body.data, readResults[1].body.data);
  assert.equal(
    (await call("notifications/unread-count", "GET", undefined, head.token))
      .body.data.unreadCount,
    3,
  );
  assert.equal(
    (await call("notifications?state=read", "GET", undefined, head.token)).body
      .data.total,
    1,
  );
  assert.equal(
    (
      await call(
        "notifications?state=unread&pageSize=1&page=9",
        "GET",
        undefined,
        head.token,
      )
    ).body.data.items.length,
    0,
  );
  assert.equal(
    (await call("notifications", "GET", undefined, undefined, cookie)).body.data
      .total,
    0,
  );
  const readNotice = (await call(noticePath, "GET", undefined, head.token)).body
    .data;
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
  assert.deepEqual(
    (await call(noticePath, "GET", undefined, head.token)).body.data,
    readNotice,
  );
  assert.equal(
    (await call("notifications/unread-count", "GET", undefined, head.token))
      .body.data.unreadCount,
    3,
  );
  // A separate draft keeps the earlier lifecycle/notification counts independent.
  const attachmentDraft = await call("travel-drafts", "POST", travel, token);
  assert.equal(attachmentDraft.response.status, 201);
  const attachmentAppId = attachmentDraft.body.data.id;
  const attachmentPath = `travel-applications/${attachmentAppId}/attachments`;
  const png = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  async function uploadFile(version) {
    const form = new FormData();
    form.set("file", new File([png], "行程.png", { type: "image/png" }));
    form.set("version", String(version));
    const response = await fetch(`${origin}/api/${attachmentPath}`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { response, body: await response.json() };
  }
  const uploaded = await uploadFile(1);
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.data.version, 2);
  assert.equal(uploaded.body.data.attachment.originalName, "行程.png");
  assert.equal(uploaded.body.data.attachment.storageKey, undefined);
  const attachment = uploaded.body.data.attachment;
  const contentPath = `${attachmentPath}/${attachment.id}/content`;
  async function downloadFile(bearer, disposition = "attachment") {
    return fetch(`${origin}/api/${contentPath}?disposition=${disposition}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10000),
    });
  }
  const download = await downloadFile(token);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  assert.equal((await downloadFile(finance.token)).status, 404);
  assert.equal(
    (await call(attachmentPath, "GET", undefined, undefined, cookie)).response
      .status,
    404,
  );
  assert.equal((await uploadFile(1)).response.status, 409);
  const secondFile = await uploadFile(2);
  assert.equal(secondFile.response.status, 201);
  assert.equal(secondFile.body.data.version, 3);
  const deletedFile = await call(
    `${attachmentPath}/${secondFile.body.data.attachment.id}`,
    "DELETE",
    { version: 3 },
    token,
  );
  assert.equal(deletedFile.response.status, 200);
  assert.equal(deletedFile.body.data.version, 4);
  const attachmentList = (await call(attachmentPath, "GET", undefined, token))
    .body.data;
  assert.deepEqual(attachmentList.items, [attachment]);
  assert.equal(attachmentList.totalBytes, png.length);
  assert.equal(attachmentList.version, 4);
  const attachmentSubmission = await call(
    `travel-drafts/${attachmentAppId}/submit`,
    "POST",
    { version: 4 },
    token,
  );
  assert.equal(attachmentSubmission.response.status, 200);
  assert.equal(attachmentSubmission.body.data.application.version, 5);
  assert.equal((await uploadFile(5)).response.status, 409);
  assert.equal(
    (
      await call(
        `${attachmentPath}/${attachment.id}`,
        "DELETE",
        { version: 5 },
        token,
      )
    ).response.status,
    409,
  );
  // Copy a terminal source without changing its history; repeats reuse the same successor.
  const resubmissionPath = `travel-applications/${rejectedTravel.application.id}/resubmission`;
  assert.equal(
    (await call(resubmissionPath, "GET", undefined, head.token)).response
      .status,
    404,
  );
  assert.equal(
    (await call(resubmissionPath, "GET", undefined, token)).body.data.successor,
    null,
  );
  const copies = await Promise.all(
    [1, 2].map(() =>
      call(
        resubmissionPath,
        "POST",
        { version: rejection.body.data.application.version },
        token,
      ),
    ),
  );
  assert.deepEqual(
    copies.map((item) => item.response.status).sort(),
    [200, 201],
  );
  const copiedId = copies[0].body.data.successor.id;
  assert.equal(copies[1].body.data.successor.id, copiedId);
  const copiedDraft = (
    await call(`travel-drafts/${copiedId}`, "GET", undefined, token)
  ).body.data;
  assert.equal(copiedDraft.resubmissionOf, rejectedTravel.application.id);
  assert.equal(copiedDraft.version, 1);
  assert.notEqual(copiedDraft.appNo, rejectedTravel.application.appNo);
  assert.deepEqual(
    (
      await call(
        `travel-applications/${copiedId}/attachments`,
        "GET",
        undefined,
        token,
      )
    ).body.data.items,
    [],
  );
  const editedCopy = await call(
    `travel-drafts/${copiedId}`,
    "PUT",
    { ...travel, title: "修改后重提", version: 1 },
    token,
  );
  assert.equal(editedCopy.response.status, 200);
  const resubmitted = await call(
    `travel-drafts/${copiedId}/submit`,
    "POST",
    { version: editedCopy.body.data.version },
    token,
  );
  assert.equal(resubmitted.response.status, 200);
  assert.notEqual(
    resubmitted.body.data.workflow.id,
    rejection.body.data.workflow.id,
  );
  assert.equal(
    resubmitted.body.data.application.resubmissionOf,
    rejectedTravel.application.id,
  );
  assert.deepEqual(
    (
      await call(
        `travel-applications/${rejectedTravel.application.id}`,
        "GET",
        undefined,
        token,
      )
    ).body.data,
    rejection.body.data,
  );
  const relationBeforeRestart = (
    await call(resubmissionPath, "GET", undefined, token)
  ).body.data;
  // Fixed purchase drafts are isolated from travel APIs and do not start approval.
  const purchaseInput = {
    title: "采购草稿 HTTP 验收",
    reason: "设备更新",
    expectedDate: "2028-02-29",
    budgetLimit: "1000",
    singleSource: false,
    items: [
      { name: "物品甲", quantity: "1.5", unit: "件", unitPrice: "0.33" },
      { name: "物品乙", quantity: "3", unitPrice: "0.10" },
    ],
    quotes: [
      { supplierName: "甲", amount: "0.80", basis: "询价记录", selected: true },
      { supplierName: "乙", amount: "0.70" },
    ],
  };
  const purchaseCreated = await call(
    "purchase-drafts",
    "POST",
    purchaseInput,
    token,
  );
  assert.equal(purchaseCreated.response.status, 201);
  const purchaseId = purchaseCreated.body.data.id;
  assert.equal(purchaseCreated.body.data.totalAmount, "0.80");
  assert.equal(
    (await call(`purchase-drafts/${purchaseId}`, "GET", undefined, head.token))
      .response.status,
    404,
  );
  assert.equal(
    (await call(`travel-drafts/${purchaseId}`, "GET", undefined, token))
      .response.status,
    404,
  );
  assert.equal(
    (await call("purchase-drafts?page=1&page=2", "GET", undefined, token))
      .response.status,
    400,
  );
  const purchaseEdited = await call(
    `purchase-drafts/${purchaseId}`,
    "PUT",
    {
      ...purchaseInput,
      version: 1,
      title: "采购草稿修改后",
      items: purchaseCreated.body.data.items.map(({ amount, ...item }) => {
        void amount;
        return item;
      }),
      quotes: purchaseCreated.body.data.quotes
        .slice()
        .reverse()
        .map((quote, index) => ({ ...quote, selected: index === 0 })),
    },
    token,
  );
  assert.equal(purchaseEdited.response.status, 200);
  assert.equal(
    purchaseEdited.body.data.items[0].id,
    purchaseCreated.body.data.items[0].id,
  );
  assert.equal(
    purchaseEdited.body.data.quotes[0].id,
    purchaseCreated.body.data.quotes[1].id,
  );
  assert.equal(purchaseEdited.body.data.version, 2);
  assert.equal(
    (
      await call(
        `purchase-drafts/${purchaseId}`,
        "DELETE",
        { version: 1 },
        token,
      )
    ).response.status,
    409,
  );
  const purchaseQuoteId = purchaseEdited.body.data.quotes[0].id;
  const purchaseAttachmentPath = `purchase-drafts/${purchaseId}/attachments`;
  async function uploadPurchaseQuote(version) {
    const data = new FormData();
    data.set("file", new File([png], "报价.png", { type: "image/png" }));
    data.set("version", String(version));
    return fetch(
      `${origin}/api/purchase-drafts/${purchaseId}/quotes/${purchaseQuoteId}/attachments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Origin: origin },
        body: data,
        signal: AbortSignal.timeout(10000),
      },
    );
  }
  const purchaseUpload = await uploadPurchaseQuote(2);
  assert.equal(purchaseUpload.status, 201);
  const purchaseFile = (await purchaseUpload.json()).data.attachment;
  assert.equal(purchaseFile.quoteId, purchaseQuoteId);
  assert.equal((await uploadPurchaseQuote(2)).status, 409);
  const quoteDrop = await call(
    `purchase-drafts/${purchaseId}`,
    "PUT",
    { version: 3 },
    token,
  );
  assert.equal(quoteDrop.response.status, 409);
  assert.equal(quoteDrop.body.error.code, "QUOTE_HAS_ATTACHMENTS");
  const purchaseFilesBefore = (
    await call(purchaseAttachmentPath, "GET", undefined, token)
  ).body.data;
  assert.deepEqual(purchaseFilesBefore.items, [purchaseFile]);
  assert.equal(purchaseFilesBefore.version, 3);
  const purchaseBeforeRestart = (
    await call(`purchase-drafts/${purchaseId}`, "GET", undefined, token)
  ).body.data;
  const purchaseContentUrl = `${origin}/api/${purchaseAttachmentPath}/${purchaseFile.id}/content?disposition=inline`;
  assert.equal(
    (
      await fetch(purchaseContentUrl, {
        headers: { Authorization: `Bearer ${head.token}` },
      })
    ).status,
    404,
  );
  const purchasePreview = await fetch(purchaseContentUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(purchasePreview.status, 200);
  assert.match(purchasePreview.headers.get("content-disposition"), /^inline;/);
  assert.match(
    purchasePreview.headers.get("content-security-policy"),
    /sandbox/,
  );
  assert.deepEqual(Buffer.from(await purchasePreview.arrayBuffer()), png);
  const purchaseListBefore = (
    await call(
      "purchase-drafts?keyword=采购草稿修改后",
      "GET",
      undefined,
      token,
    )
  ).body.data;
  assert.equal(purchaseListBefore.total, 1);
  assert.equal(purchaseListBefore.items[0].totalAmount, "0.80");
  const preview = await downloadFile(head.token, "inline");
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition"), /^inline;/);
  assert.match(preview.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  assert.equal((await downloadFile(finance.token)).status, 404);
  // S4c keeps the S4b draft/delete fixture and adds a separate submitted purchase.
  const companyHead = await approver(
    "companyhead",
    "company_head",
    financeDepartment.id,
  );
  const purchaseReady = await call(
    "purchase-drafts",
    "POST",
    {
      ...purchaseInput,
      title: "采购提交 HTTP 验收",
      selectionReason: "交货日期更合适",
      items: purchaseInput.items.map((item) => ({
        ...item,
        specification: "标准型",
        unit: "件",
      })),
      quotes: purchaseInput.quotes.map((quote, index) => ({
        ...quote,
        quoteDate: "2028-02-01",
        basis: "询价记录",
        isOnline: index === 0,
        purchaseUrl: index === 0 ? "https://example.invalid/item" : "",
      })),
    },
    token,
  );
  assert.equal(purchaseReady.response.status, 201);
  const submittedPurchaseId = purchaseReady.body.data.id;
  const purchaseSubmitPath = `purchase-drafts/${submittedPurchaseId}/submit`;
  assert.equal(
    (await call(purchaseSubmitPath, "POST", { version: 1 }, token)).response
      .status,
    400,
  );
  const proofForm = new FormData();
  proofForm.set("file", new File([png], "采购截图.png", { type: "image/png" }));
  proofForm.set("version", "1");
  const proofResponse = await fetch(
    `${origin}/api/purchase-drafts/${submittedPurchaseId}/quotes/${purchaseReady.body.data.quotes[0].id}/attachments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: proofForm,
    },
  );
  assert.equal(proofResponse.status, 201);
  const proof = (await proofResponse.json()).data.attachment;
  const purchaseSubmitted = await call(
    purchaseSubmitPath,
    "POST",
    { version: 2 },
    token,
  );
  assert.equal(purchaseSubmitted.response.status, 200);
  const purchaseSnapshot = purchaseSubmitted.body.data;
  assert.equal(purchaseSnapshot.workflow.ruleVersion, "fixed-purchase-v1");
  assert.equal(purchaseSnapshot.workflow.routeSnapshot.selectedNotLowest, true);
  assert.deepEqual(
    purchaseSnapshot.tasks.map((task) => [task.approverId, task.status]),
    [
      [head.id, "pending"],
      [companyHead.id, "blocked"],
    ],
  );
  assert.equal(purchaseSnapshot.application.version, 3);
  const purchaseDetailPath = `purchase-applications/${submittedPurchaseId}`;
  const purchaseProofPath = `${origin}/api/${purchaseDetailPath}/attachments/${proof.id}/content?disposition=inline`;
  for (const actor of [head, companyHead, finance]) {
    const allowed = actor.id === head.id;
    assert.equal(
      (await call(purchaseDetailPath, "GET", undefined, actor.token)).response
        .status,
      allowed ? 200 : 404,
    );
    const content = await fetch(purchaseProofPath, {
      headers: { Authorization: `Bearer ${actor.token}` },
    });
    assert.equal(content.status, allowed ? 200 : 404);
    if (allowed)
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  }
  assert.equal(
    (await call(purchaseSubmitPath, "POST", { version: 2 }, token)).response
      .status,
    409,
  );
  assert.equal(
    (
      await call(
        `purchase-drafts/${submittedPurchaseId}`,
        "DELETE",
        { version: 3 },
        token,
      )
    ).response.status,
    409,
  );
  const purchaseSubmittedFiles = (
    await call(
      `${purchaseDetailPath}/attachments`,
      "GET",
      undefined,
      head.token,
    )
  ).body.data;
  assert.deepEqual(purchaseSubmittedFiles.items, [proof]);
  const purchaseNotice = (
    await call("notifications?pageSize=100", "GET", undefined, head.token)
  ).body.data.items.find((item) => item.appId === submittedPurchaseId);
  assert.equal(purchaseNotice.target.apiPath, `/api/${purchaseDetailPath}`);
  assert.equal(purchaseNotice.target.type, "purchase");
  // S4d exercises all procurement terminals without replacing the S4c pending fixture.
  const purchaseTerminals = [];
  for (const outcome of [
    "approved",
    "reject-first",
    "reject-last",
    "withdraw-first",
    "withdraw-last",
  ]) {
    const created = await call(
      "purchase-drafts",
      "POST",
      {
        title: `采购审批 HTTP ${outcome}`,
        reason: "设备更新",
        expectedDate: "2028-02-29",
        budgetLimit: "1000",
        selectionReason: "独家适配",
        singleSource: true,
        singleSourceReason: "独家授权",
        items: [
          {
            name: "设备",
            specification: "标准型",
            quantity: "2",
            unit: "件",
            unitPrice: "100",
          },
        ],
        quotes: [
          {
            supplierName: "授权供应商",
            quoteDate: "2028-02-01",
            amount: "200",
            basis: "询价记录",
            selected: true,
            isOnline: true,
            purchaseUrl: "https://example.invalid/item",
          },
        ],
      },
      token,
    );
    assert.equal(created.response.status, 201);
    const saved = created.body.data;
    const evidence = new FormData();
    evidence.set(
      "file",
      new File([png], "报价截图.png", { type: "image/png" }),
    );
    evidence.set("version", "1");
    const upload = await fetch(
      `${origin}/api/purchase-drafts/${saved.id}/quotes/${saved.quotes[0].id}/attachments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: evidence,
      },
    );
    assert.equal(upload.status, 201);
    const file = (await upload.json()).data.attachment;
    const started = await call(
      `purchase-drafts/${saved.id}/submit`,
      "POST",
      { version: 2 },
      token,
    );
    assert.equal(started.response.status, 200);
    const initial = started.body.data;
    let current = initial;
    const path = `purchase-applications/${saved.id}`;
    const decision = (value, index, decision, actorToken, opinion = "") =>
      call(
        `${path}/tasks/${value.tasks[index].id}/decision`,
        "POST",
        { version: value.application.version, decision, opinion },
        actorToken,
      );
    assert.equal(
      (await decision(initial, 1, "approve", companyHead.token)).response
        .status,
      409,
    );
    assert.equal(
      (await decision(initial, 0, "approve", token)).response.status,
      403,
    );
    assert.equal(
      (await decision(initial, 0, "approve", finance.token)).response.status,
      404,
    );
    assert.equal(
      (await decision(initial, 0, "reject", head.token, " ")).response.status,
      400,
    );
    const activated = ["approved", "reject-last", "withdraw-last"].includes(
      outcome,
    );
    if (activated) {
      const first = await decision(
        current,
        0,
        "approve",
        head.token,
        "同意采购",
      );
      assert.equal(first.response.status, 200);
      current = first.body.data;
      assert.deepEqual(
        current.tasks.map((task) => task.status),
        ["approved", "pending"],
      );
      assert.equal(
        (await decision(initial, 0, "approve", head.token)).response.status,
        409,
      );
    }
    const result = outcome.startsWith("withdraw")
      ? await call(
          `${path}/withdraw`,
          "POST",
          { version: current.application.version, opinion: "计划调整" },
          token,
        )
      : await decision(
          current,
          activated ? 1 : 0,
          outcome === "approved" ? "approve" : "reject",
          activated ? companyHead.token : head.token,
          "核验后处理",
        );
    assert.equal(result.response.status, 200);
    const terminal = result.body.data;
    assert.equal(
      terminal.application.status,
      outcome === "approved"
        ? "approved"
        : outcome.startsWith("reject")
          ? "rejected"
          : "withdrawn",
    );
    assert.equal(terminal.application.version, activated ? 5 : 4);
    assert.equal(terminal.logs.length, activated ? 3 : 2);
    assert.deepEqual(terminal.workflow, initial.workflow);
    assert.deepEqual(terminal.application.items, initial.application.items);
    assert.deepEqual(terminal.application.quotes, initial.application.quotes);
    assert.equal(
      terminal.tasks.some(
        (task) => task.status === "pending" || task.status === "blocked",
      ),
      false,
    );
    assert.equal(
      (
        await call(
          `${path}/withdraw`,
          "POST",
          { version: terminal.application.version },
          token,
        )
      ).response.status,
      409,
    );
    assert.equal(
      (
        await decision(
          terminal,
          activated ? 1 : 0,
          "approve",
          activated ? companyHead.token : head.token,
        )
      ).response.status,
      409,
    );
    const attachmentState = (
      await call(`${path}/attachments`, "GET", undefined, head.token)
    ).body.data;
    assert.deepEqual(attachmentState.items, [file]);
    assert.equal(attachmentState.status, terminal.application.status);
    for (const actor of [companyHead, finance]) {
      const allowed = actor.id === companyHead.id && activated;
      assert.equal(
        (await call(path, "GET", undefined, actor.token)).response.status,
        allowed ? 200 : 404,
      );
      const bytes = await fetch(
        `${origin}/api/${path}/attachments/${file.id}/content`,
        { headers: { Authorization: `Bearer ${actor.token}` } },
      );
      assert.equal(bytes.status, allowed ? 200 : 404);
      if (allowed)
        assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
    }
    const noticeState = [];
    for (const actorToken of [token, head.token, companyHead.token]) {
      const list = await call(
        "notifications?pageSize=100",
        "GET",
        undefined,
        actorToken,
      );
      assert.equal(list.response.status, 200);
      const items = list.body.data.items.filter(
        (item) => item.appId === saved.id,
      );
      for (const item of items) {
        assert.equal(item.target.status, terminal.application.status);
        if (item.task) assert.notEqual(item.task.status, "pending");
      }
      noticeState.push({ token: actorToken, items });
    }
    const finalKind = `application.${terminal.application.status}`;
    assert.equal(
      noticeState[0].items.filter((item) => item.kind === finalKind).length,
      1,
    );
    if (outcome.startsWith("withdraw")) {
      assert.equal(
        noticeState[1].items.filter((item) => item.kind === finalKind).length,
        1,
      );
      assert.equal(
        noticeState[2].items.filter((item) => item.kind === finalKind).length,
        activated ? 1 : 0,
      );
    }
    purchaseTerminals.push({
      path,
      terminal,
      attachmentState,
      file,
      activated,
      noticeState,
    });
  }
  // S4e lists keep ownership, task decisions and amounts separate from travel.
  const purchaseListSnapshots = [];
  async function listSnapshot(path, actorToken, expectedTotal) {
    const result = await call(path, "GET", undefined, actorToken);
    assert.equal(result.response.status, 200);
    if (expectedTotal !== undefined)
      assert.equal(result.body.data.total, expectedTotal);
    purchaseListSnapshots.push({
      path,
      token: actorToken,
      data: result.body.data,
    });
    return result.body.data;
  }
  const allPurchases = await listSnapshot(
    "purchase-applications?pageSize=100",
    token,
    7,
  );
  assert.deepEqual(allPurchases.items.map((item) => item.status).sort(), [
    "approved",
    "draft",
    "pending",
    "rejected",
    "rejected",
    "withdrawn",
    "withdrawn",
  ]);
  assert(
    allPurchases.items.every(
      (item) =>
        item.type === "purchase" && typeof item.totalAmount === "string",
    ),
  );
  assert.equal(
    allPurchases.items.find((item) => item.id === purchaseId).totalAmount,
    "0.80",
  );
  assert.equal(
    allPurchases.items.find((item) => item.id === submittedPurchaseId)
      .currentTask.approver.id,
    head.id,
  );
  for (const [status, total] of [
    ["draft", 1],
    ["pending", 1],
    ["approved", 1],
    ["rejected", 2],
    ["withdrawn", 2],
  ])
    await listSnapshot(`purchase-applications?status=${status}`, token, total);
  const firstPage = await listSnapshot(
    "purchase-applications?pageSize=2",
    token,
    7,
  );
  const nextPage = await listSnapshot(
    "purchase-applications?pageSize=2&page=2",
    token,
    7,
  );
  assert.deepEqual(
    [...firstPage.items, ...nextPage.items],
    allPurchases.items.slice(0, 4),
  );
  assert.deepEqual(
    (await listSnapshot("purchase-applications?pageSize=2&page=99", token, 7))
      .items,
    [],
  );
  await listSnapshot(
    "purchase-applications?from=0001-01-01&to=9999-12-31&type=purchase",
    token,
    7,
  );
  const ownOne = await listSnapshot(
    `purchase-applications?keyword=${purchaseSnapshot.application.appNo.toLowerCase()}`,
    token,
    1,
  );
  assert.equal(ownOne.items[0].id, submittedPurchaseId);
  for (const actorToken of [head.token, companyHead.token, finance.token])
    await listSnapshot("purchase-applications", actorToken, 0);
  const currentPurchaseTasks = await listSnapshot(
    "purchase-tasks",
    head.token,
    1,
  );
  assert.equal(currentPurchaseTasks.items[0].id, purchaseSnapshot.tasks[0].id);
  assert.equal(currentPurchaseTasks.items[0].application.totalAmount, "0.80");
  await listSnapshot("purchase-tasks?state=handled", head.token, 4);
  const companyHandled = await listSnapshot(
    "purchase-tasks?state=handled",
    companyHead.token,
    2,
  );
  assert(
    companyHandled.items.every((item) =>
      ["approved", "rejected"].includes(item.status),
    ),
  );
  for (const actorToken of [token, companyHead.token, finance.token])
    await listSnapshot("purchase-tasks", actorToken, 0);
  const handledRejected = await listSnapshot(
    "purchase-tasks?state=handled&status=rejected",
    head.token,
    2,
  );
  assert.deepEqual(handledRejected.items.map((item) => item.status).sort(), [
    "approved",
    "rejected",
  ]);
  await listSnapshot(
    "purchase-tasks?state=handled&status=withdrawn",
    head.token,
    1,
  );
  assert.deepEqual(
    (
      await listSnapshot(
        "purchase-tasks?state=handled&page=99&pageSize=1",
        head.token,
        4,
      )
    ).items,
    [],
  );
  for (const path of [
    "purchase-applications?type=travel",
    "purchase-tasks?type=travel",
    "purchase-tasks?page=1&page=2",
    "purchase-applications?applicantId=" + head.id,
  ])
    assert.equal(
      (await call(path, "GET", undefined, token)).response.status,
      400,
    );
  assert.equal((await call("purchase-applications")).response.status, 401);
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
  for (const listing of purchaseListSnapshots)
    assert.deepEqual(
      (await call(listing.path, "GET", undefined, listing.token)).body.data,
      listing.data,
    );
  for (const entry of purchaseTerminals) {
    assert.deepEqual(
      (await call(entry.path, "GET", undefined, token)).body.data,
      entry.terminal,
    );
    assert.deepEqual(
      (await call(`${entry.path}/attachments`, "GET", undefined, head.token))
        .body.data,
      entry.attachmentState,
    );
    const bytes = await fetch(
      `${origin}/api/${entry.path}/attachments/${entry.file.id}/content`,
      { headers: { Authorization: `Bearer ${head.token}` } },
    );
    assert.equal(bytes.status, 200);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
    assert.equal(
      (await call(entry.path, "GET", undefined, companyHead.token)).response
        .status,
      entry.activated ? 200 : 404,
    );
    for (const notice of entry.noticeState) {
      const list = await call(
        "notifications?pageSize=100",
        "GET",
        undefined,
        notice.token,
      );
      assert.deepEqual(
        list.body.data.items.filter(
          (item) => item.appId === entry.terminal.application.id,
        ),
        notice.items,
      );
    }
  }
  assert.deepEqual(
    (await call(purchaseDetailPath, "GET", undefined, head.token)).body.data,
    purchaseSnapshot,
  );
  assert.deepEqual(
    (
      await call(
        `${purchaseDetailPath}/attachments`,
        "GET",
        undefined,
        head.token,
      )
    ).body.data,
    purchaseSubmittedFiles,
  );
  const persistedProof = await fetch(purchaseProofPath, {
    headers: { Authorization: `Bearer ${head.token}` },
  });
  assert.equal(persistedProof.status, 200);
  assert.deepEqual(Buffer.from(await persistedProof.arrayBuffer()), png);
  assert.equal(
    (await call(purchaseDetailPath, "GET", undefined, companyHead.token))
      .response.status,
    404,
  );
  assert.deepEqual(
    (await call(resubmissionPath, "GET", undefined, token)).body.data,
    relationBeforeRestart,
  );
  assert.deepEqual(
    (await call(`travel-applications/${copiedId}`, "GET", undefined, token))
      .body.data,
    resubmitted.body.data,
  );
  assert.deepEqual(
    (
      await call(
        `travel-applications/${rejectedTravel.application.id}`,
        "GET",
        undefined,
        token,
      )
    ).body.data,
    rejection.body.data,
  );
  const replay = await call(
    resubmissionPath,
    "POST",
    { version: rejection.body.data.application.version },
    token,
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.successor.id, copiedId);
  assert.deepEqual(
    (await call(`purchase-drafts/${purchaseId}`, "GET", undefined, token)).body
      .data,
    purchaseBeforeRestart,
  );
  assert.deepEqual(
    (
      await call(
        "purchase-drafts?keyword=采购草稿修改后",
        "GET",
        undefined,
        token,
      )
    ).body.data,
    purchaseListBefore,
  );
  assert.deepEqual(
    (await call(purchaseAttachmentPath, "GET", undefined, token)).body.data,
    purchaseFilesBefore,
  );
  const purchasePersisted = await fetch(purchaseContentUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(purchasePersisted.status, 200);
  assert.deepEqual(Buffer.from(await purchasePersisted.arrayBuffer()), png);
  assert.equal(
    (
      await call(
        `${purchaseAttachmentPath}/${purchaseFile.id}`,
        "DELETE",
        { version: 3 },
        token,
      )
    ).response.status,
    200,
  );
  assert.equal(
    (
      await fetch(purchaseContentUrl, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    404,
  );
  // Leave a new file attached to exercise whole-draft metadata and storage cleanup.
  assert.equal((await uploadPurchaseQuote(4)).status, 201);
  assert.equal(
    (
      await call(
        `purchase-drafts/${purchaseId}`,
        "DELETE",
        { version: 5 },
        token,
      )
    ).response.status,
    200,
  );
  assert.equal(
    (await call(`purchase-drafts/${purchaseId}`, "GET", undefined, token))
      .response.status,
    404,
  );
  const persistedDownload = await downloadFile(head.token);
  assert.equal(persistedDownload.status, 200);
  assert.deepEqual(Buffer.from(await persistedDownload.arrayBuffer()), png);
  const persistedAttachments = (
    await call(attachmentPath, "GET", undefined, head.token)
  ).body.data;
  assert.deepEqual(persistedAttachments.items, [attachment]);
  assert.equal(persistedAttachments.status, "pending");
  assert.equal(persistedAttachments.version, 5);
  // S4i: copy a terminal purchase with online evidence, then verify the new chain after restart.
  const retrySource = purchaseTerminals.find(
    (entry) => entry.terminal.application.status === "rejected",
  );
  const purchaseRetryPath = `${retrySource.path}/resubmission`;
  assert.equal(
    (await call(purchaseRetryPath, "GET", undefined, head.token)).response
      .status,
    404,
  );
  const purchaseCopied = await call(
    purchaseRetryPath,
    "POST",
    { version: retrySource.terminal.application.version },
    token,
  );
  assert.equal(purchaseCopied.response.status, 201);
  const purchaseChild = purchaseCopied.body.data.successor;
  const childPath = `purchase-drafts/${purchaseChild.id}`;
  const copiedPurchase = (await call(childPath, "GET", undefined, token)).body
    .data;
  assert.equal(
    copiedPurchase.resubmissionOf,
    retrySource.terminal.application.id,
  );
  assert.equal(copiedPurchase.version, 1);
  assert.equal(
    copiedPurchase.totalAmount,
    retrySource.terminal.application.totalAmount,
  );
  assert.notEqual(
    copiedPurchase.quotes[0].id,
    retrySource.terminal.application.quotes[0].id,
  );
  assert.deepEqual(
    (await call(`${childPath}/attachments`, "GET", undefined, token)).body.data
      .items,
    [],
  );
  assert.equal(
    (await call(`${childPath}/submit`, "POST", { version: 1 }, token)).response
      .status,
    400,
  );
  const newEvidence = new FormData();
  newEvidence.set(
    "file",
    new File([png], "重新上传报价.png", { type: "image/png" }),
  );
  newEvidence.set("version", "1");
  const childUpload = await fetch(
    `${origin}/api/${childPath}/quotes/${copiedPurchase.quotes[0].id}/attachments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: newEvidence,
    },
  );
  assert.equal(childUpload.status, 201);
  const childFile = (await childUpload.json()).data.attachment;
  const childSent = await call(
    `${childPath}/submit`,
    "POST",
    { version: 2 },
    token,
  );
  assert.equal(childSent.response.status, 200);
  const purchaseRetried = childSent.body.data;
  assert.notEqual(
    purchaseRetried.workflow.id,
    retrySource.terminal.workflow.id,
  );
  assert.deepEqual(
    purchaseRetried.tasks.map((task) => task.status),
    ["pending", "blocked"],
  );
  assert.equal(purchaseRetried.logs.length, 1);
  const repeatedPurchaseCopy = await call(
    purchaseRetryPath,
    "POST",
    { version: retrySource.terminal.application.version },
    token,
  );
  assert.equal(repeatedPurchaseCopy.response.status, 200);
  assert.equal(repeatedPurchaseCopy.body.data.created, false);
  assert.equal(repeatedPurchaseCopy.body.data.successor.id, purchaseChild.id);
  // S4j: owned approved link options and multi-line reimbursement drafts.
  const eligibleResponse = await call(
    "reimbursement-link-options?pageSize=100",
    "GET",
    undefined,
    token,
  );
  assert.equal(eligibleResponse.response.status, 200);
  const eligible = eligibleResponse.body.data;
  const expenseSources = ["travel", "purchase"].map((type) => {
    const item = eligible.items.find((item) => item.type === type);
    assert(item);
    assert.equal(item.status, "approved");
    return item;
  });
  const originalExpenseSources = await Promise.all(
    expenseSources.map(async (source) => ({
      path: `${source.type}-applications/${source.id}`,
      data: (
        await call(
          `${source.type}-applications/${source.id}`,
          "GET",
          undefined,
          token,
        )
      ).body.data,
    })),
  );
  const expenseFields = {
    title: "关联报销 HTTP",
    description: "实际费用",
    independentReason: "",
    remarks: "核对原单",
    linkedApplicationIds: expenseSources.map((source) => source.id),
    items: [
      {
        category: "transport",
        expenseDate: "2028-02-29",
        purpose: "车费",
        amount: "0.1",
      },
      {
        category: "lodging",
        expenseDate: "2028-03-01",
        purpose: "住宿",
        amount: "0.2",
      },
      {
        category: "meals",
        expenseDate: "2028-03-01",
        purpose: "餐饮",
        amount: "1.23",
        noReceipt: true,
        noReceiptReason: "遗失",
      },
    ],
  };
  const createdExpense = await call(
    "reimbursement-drafts",
    "POST",
    expenseFields,
    token,
  );
  assert.equal(createdExpense.response.status, 201);
  const expenseDraft = createdExpense.body.data;
  const expensePath = `reimbursement-drafts/${expenseDraft.id}`;
  assert.equal(expenseDraft.totalAmount, "1.53");
  assert.equal(expenseDraft.noReceiptCount, 1);
  assert.equal(expenseDraft.linkedApplications.length, 2);
  assert.equal(
    expenseDraft.linkedApplications.find((item) => item.type === "travel")
      .travel.destination,
    originalExpenseSources[0].data.application.destination,
  );
  for (const actorToken of [head.token, finance.token]) {
    assert.equal(
      (await call(expensePath, "GET", undefined, actorToken)).response.status,
      404,
    );
    assert.equal(
      (await call("reimbursement-drafts", "POST", expenseFields, actorToken))
        .response.status,
      404,
    );
  }
  assert.equal(
    (await call(expensePath, "GET", undefined, undefined, cookie)).response
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        "reimbursement-drafts",
        "POST",
        expenseFields,
        undefined,
        cookie,
      )
    ).response.status,
    404,
  );
  assert.equal(
    (
      await call(
        "reimbursement-drafts",
        "POST",
        { ...expenseFields, linkedApplicationIds: [purchaseChild.id] },
        token,
      )
    ).response.status,
    404,
  );
  // S4k: real receipt multipart requests, owner-only bytes and item deletion protection.
  const { PDFDocument } = await import("pdf-lib");
  const receiptDocument = await PDFDocument.create();
  receiptDocument.addPage([100, 100]);
  const receiptPdf = Buffer.from(await receiptDocument.save());
  const receiptJpeg = await sharp(png).jpeg().toBuffer();
  const receiptPayloads = [
    [png, "交通票据.png", "image/png"],
    [receiptJpeg, "交通补充.jpg", "image/jpeg"],
    [receiptPdf, "住宿票据.pdf", "application/pdf"],
  ];
  const receiptFiles = [];
  async function uploadReceipt(version, index, actorToken = token) {
    const [bytes, name, type] = receiptPayloads[index];
    const body = new FormData();
    body.set("file", new File([bytes], name, { type }));
    body.set("version", String(version));
    body.set("receiptNumber", `  HTTP-RECEIPT-${index + 1}  `);
    return fetch(
      `${origin}/api/${expensePath}/items/${expenseDraft.items[index === 2 ? 1 : 0].id}/attachments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${actorToken}`, Origin: origin },
        body,
        signal: AbortSignal.timeout(10000),
      },
    );
  }
  for (let i = 0; i < 3; i++) {
    const response = await uploadReceipt(i + 1, i);
    assert.equal(response.status, 201);
    const saved = (await response.json()).data;
    assert.equal(saved.version, i + 2);
    assert.equal(saved.attachment.receiptNumber, `HTTP-RECEIPT-${i + 1}`);
    assert.equal(
      saved.attachment.itemId,
      expenseDraft.items[i === 2 ? 1 : 0].id,
    );
    assert.equal(saved.attachment.storageKey, undefined);
    receiptFiles.push(saved.attachment);
  }
  assert.equal((await uploadReceipt(1, 0)).status, 409);
  assert.equal((await uploadReceipt(4, 0, head.token)).status, 404);
  for (const actorToken of [head.token, finance.token]) {
    assert.equal(
      (await call(`${expensePath}/attachments`, "GET", undefined, actorToken))
        .response.status,
      404,
    );
    const denied = await fetch(
      `${origin}/api/${expensePath}/attachments/${receiptFiles[0].id}/content`,
      { headers: { Authorization: `Bearer ${actorToken}` } },
    );
    assert.equal(denied.status, 404);
  }
  const protectedItems = await call(expensePath, "PUT", { version: 4 }, token);
  assert.equal(protectedItems.response.status, 409);
  assert.equal(protectedItems.body.error.code, "ITEM_HAS_ATTACHMENTS");
  const editedExpense = await call(
    expensePath,
    "PUT",
    {
      ...expenseFields,
      title: "关联报销修改后",
      version: 4,
      items: [...expenseDraft.items].reverse(),
    },
    token,
  );
  assert.equal(editedExpense.response.status, 200);
  const expenseBeforeRestart = editedExpense.body.data;
  assert.deepEqual(
    expenseBeforeRestart.items.map((item) => item.id),
    expenseDraft.items.map((item) => item.id).reverse(),
  );
  assert.equal(expenseBeforeRestart.version, 5);
  assert.equal(
    (await call(expensePath, "PUT", { version: 1 }, token)).response.status,
    409,
  );
  assert.equal(
    (await call(expensePath, "DELETE", { version: 1 }, token)).response.status,
    409,
  );
  const expenseListBefore = (
    await call(
      "reimbursement-drafts?keyword=关联报销修改后&pageSize=1",
      "GET",
      undefined,
      token,
    )
  ).body.data;
  assert.equal(expenseListBefore.total, 1);
  assert.equal(expenseListBefore.items[0].totalAmount, "1.53");
  const independent = await call(
    "reimbursement-drafts",
    "POST",
    { independentReason: "独立支出", items: [{}] },
    token,
  );
  assert.equal(independent.response.status, 201);
  assert.equal(independent.body.data.totalAmount, null);
  assert.equal(
    (
      await call(
        `reimbursement-drafts/${independent.body.data.id}`,
        "DELETE",
        { version: 1 },
        token,
      )
    ).response.status,
    200,
  );
  const receiptsBeforeRestart = (
    await call(`${expensePath}/attachments`, "GET", undefined, token)
  ).body.data;
  assert.deepEqual(receiptsBeforeRestart.items, receiptFiles);
  assert.equal(receiptsBeforeRestart.version, 5);
  assert.equal(
    receiptsBeforeRestart.totalBytes,
    receiptPayloads.reduce((sum, [bytes]) => sum + bytes.length, 0),
  );
  const purchaseRelationBefore = (
    await call(purchaseRetryPath, "GET", undefined, token)
  ).body.data;
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
  assert.deepEqual(
    (await call(purchaseRetryPath, "GET", undefined, token)).body.data,
    purchaseRelationBefore,
  );
  assert.deepEqual(
    (
      await call(
        `purchase-applications/${purchaseChild.id}`,
        "GET",
        undefined,
        token,
      )
    ).body.data,
    purchaseRetried,
  );
  assert.deepEqual(
    (await call(retrySource.path, "GET", undefined, token)).body.data,
    retrySource.terminal,
  );
  for (const [path, file] of [
    [retrySource.path, retrySource.file],
    [`purchase-applications/${purchaseChild.id}`, childFile],
  ]) {
    const bytes = await fetch(
      `${origin}/api/${path}/attachments/${file.id}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(bytes.status, 200);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
  }
  assert.deepEqual(
    (await call(expensePath, "GET", undefined, token)).body.data,
    expenseBeforeRestart,
  );
  assert.deepEqual(
    (
      await call(
        "reimbursement-drafts?keyword=关联报销修改后&pageSize=1",
        "GET",
        undefined,
        token,
      )
    ).body.data,
    expenseListBefore,
  );
  assert.deepEqual(
    (
      await call(
        "reimbursement-link-options?pageSize=100",
        "GET",
        undefined,
        token,
      )
    ).body.data,
    eligible,
  );
  assert.deepEqual(
    (await call(`${expensePath}/attachments`, "GET", undefined, token)).body
      .data,
    receiptsBeforeRestart,
  );
  for (const [index, file] of receiptFiles.entries()) {
    const response = await fetch(
      `${origin}/api/${expensePath}/attachments/${file.id}/content?disposition=inline`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      receiptPayloads[index][2],
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      receiptPayloads[index][0],
    );
  }
  assert.equal(
    (
      await call(
        `${expensePath}/attachments/${receiptFiles[0].id}`,
        "DELETE",
        { version: 4 },
        token,
      )
    ).response.status,
    409,
  );
  const removedReceipt = await call(
    `${expensePath}/attachments/${receiptFiles[0].id}`,
    "DELETE",
    { version: 5 },
    token,
  );
  assert.equal(removedReceipt.response.status, 200);
  assert.equal(removedReceipt.body.data.version, 6);
  assert.equal(
    (await call(`${expensePath}/attachments`, "GET", undefined, token)).body
      .data.items.length,
    2,
  );
  assert.equal(
    (
      await fetch(
        `${origin}/api/${expensePath}/attachments/${receiptFiles[0].id}/content`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).status,
    404,
  );
  assert.equal(
    (await call(expensePath, "DELETE", { version: 6 }, token)).response.status,
    200,
  );
  assert.equal(
    (await call(expensePath, "GET", undefined, token)).response.status,
    404,
  );
  for (const source of originalExpenseSources)
    assert.deepEqual(
      (await call(source.path, "GET", undefined, token)).body.data,
      source.data,
    );
  assert.equal(
    (await call("auth/logout", "POST", undefined, token)).response.status,
    200,
  );
  assert.equal(
    (await call("auth/me", "GET", undefined, token)).response.status,
    401,
  );
  assert.equal(
    (await call("auth/logout", "POST", undefined, undefined, cookie)).response
      .status,
    200,
  );
  console.log(
    "Production HTTP smoke passed: identity, travel drafts/submission/actions and owned/pending/handled lists, history authorization, notifications and read timestamps, multipart attachments/upload/delete/version conflicts/controlled preview/download/freeze; fixed purchase draft CRUD/row identities/exact totals, quote attachments/ownership/deletion protection and restart bytes; purchase submission/company-head snapshots/authorized submitted detail and evidence/freeze/restart persistence; purchase approval/rejection/withdrawal at both nodes, history permissions and terminal notices/evidence after restart; purchase owned/pending/handled lists, filters/pagination/exact totals/type isolation and restart persistence; travel and purchase linked resubmission drafts/new execution, purchase online evidence re-upload and retry reuse, terminal records, metadata and attachment bytes survive production restart; reimbursement drafts/row identities/exact totals/owned approved links/independent drafts, JPEG/PNG/PDF receipts/item ownership/receipt numbers/deletion protection/original bytes after restart and deletion; logout.",
  );
} finally {
  server.child.kill("SIGTERM");
  await server.closed;
}
