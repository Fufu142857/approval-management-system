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
  const preview = await downloadFile(head.token, "inline");
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-disposition"), /^inline;/);
  assert.match(preview.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  assert.equal((await downloadFile(finance.token)).status, 404);
  server.child.kill("SIGTERM");
  await server.closed;
  server = startServer();
  await ready();
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
  const persistedDownload = await downloadFile(head.token);
  assert.equal(persistedDownload.status, 200);
  assert.deepEqual(Buffer.from(await persistedDownload.arrayBuffer()), png);
  const persistedAttachments = (
    await call(attachmentPath, "GET", undefined, head.token)
  ).body.data;
  assert.deepEqual(persistedAttachments.items, [attachment]);
  assert.equal(persistedAttachments.status, "pending");
  assert.equal(persistedAttachments.version, 5);
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
    "Production HTTP smoke passed: identity, travel drafts/submission/actions and owned/pending/handled lists, history authorization, notifications and read timestamps, multipart attachments/upload/delete/version conflicts/controlled preview/download/freeze; linked resubmission drafts/new execution and retry reuse, terminal records, metadata and attachment bytes survive production restart; logout.",
  );
} finally {
  server.child.kill("SIGTERM");
  await server.closed;
}
