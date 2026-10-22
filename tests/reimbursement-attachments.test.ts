import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { beforeAll, beforeEach, afterAll, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import {
  reimbursementDraftSchema,
  replaceReimbursementDraftSchema,
} from "../src/lib/reimbursement";
import { travelDraftSchema } from "../src/lib/travel";
import { createTravelDraft } from "../src/server/travel";
import { attachmentContentHandler as travelContent } from "../src/server/attachment-handlers";
import { maxAttachmentBytes } from "../src/lib/attachments";
import {
  createReimbursementDraft,
  getReimbursementDraft,
  replaceReimbursementDraft,
  deleteReimbursementDraft,
} from "../src/server/reimbursement";
import {
  collectAttachmentGarbage,
  lockAttachmentStorage,
  writeAttachmentObject,
} from "../src/server/attachment-storage";
import {
  uploadReimbursementAttachmentHandler as uploadHandler,
  reimbursementAttachmentsHandler as listHandler,
  deleteReimbursementAttachmentHandler as removeHandler,
  reimbursementAttachmentContentHandler as contentHandler,
} from "../src/server/reimbursement-attachment-handlers";
import { getReimbursementAttachmentContent } from "../src/server/reimbursement-attachments";
const origin = "http://localhost:3000";
const storage = resolve("tmp/attachments-vitest-test");
const people: Record<string, { id: string; token: string }> = {};
let png: Buffer, jpeg: Buffer, pdf: Buffer;
const context = (id: string, attachmentId?: string, itemId?: string) => ({
  params: Promise.resolve({ id, attachmentId, itemId }),
});
function request(
  method = "GET",
  body?: BodyInit,
  token = people.owner.token,
  headers: Record<string, string> = {},
  search = "",
) {
  return new Request(`${origin}/api/reimbursement-drafts/files${search}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}
function form(
  version = 1,
  bytes = png,
  name = "费用明细.png",
  type = "image/png",
) {
  const data = new FormData();
  data.set("file", new File([new Uint8Array(bytes)], name, { type }));
  data.set("version", String(version));
  return data;
}
const upload = (
  id: string,
  itemId: string,
  version = 1,
  bytes = png,
  name = "费用明细.png",
  type = "image/png",
  token = people.owner.token,
) =>
  uploadHandler(
    request("POST", form(version, bytes, name, type), token),
    context(id, undefined, itemId),
  );
const list = (id: string, token = people.owner.token) =>
  listHandler(request("GET", undefined, token), context(id));
const content = (
  id: string,
  fileId: string,
  token = people.owner.token,
  search = "",
) =>
  contentHandler(
    request("GET", undefined, token, {}, search),
    context(id, fileId),
  );
const remove = (
  id: string,
  fileId: string,
  version: number,
  token = people.owner.token,
) =>
  removeHandler(
    request("DELETE", JSON.stringify({ version }), token, {
      "Content-Type": "application/json",
    }),
    context(id, fileId),
  );
async function draft() {
  return createReimbursementDraft(
    people.owner.token,
    reimbursementDraftSchema.parse({
      title: "报销附件",
      items: [
        { category: "transport", amount: "100" },
        { category: "lodging", amount: "100" },
      ],
    }),
  );
}
async function uploaded(
  app: Awaited<ReturnType<typeof draft>>,
  version = 1,
  itemIndex = 0,
) {
  const response = await upload(app.id, app.items[itemIndex].id, version);
  expect(response.status).toBe(201);
  return (await response.json()).data;
}
const files = async () =>
  (await readdir(storage)).filter((name) => name.endsWith(".blob"));
async function pathFor(id: string) {
  return join(
    storage,
    (
      await database().query(
        "SELECT storage_key FROM attachments WHERE id=$1",
        [id],
      )
    ).rows[0].storage_key + ".blob",
  );
}
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = origin;
  process.env.ATTACHMENT_STORAGE_DIR = storage;
  await migrate();
  png = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  jpeg = await sharp(png).jpeg().toBuffer();
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  pdf = Buffer.from(await document.save({ useObjectStreams: false }));
});
beforeEach(async () => {
  process.env.ATTACHMENT_STORAGE_DIR = storage;
  await database().query(
    "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
  );
  await rm(storage, { recursive: true, force: true });
  await mkdir(storage, { recursive: true });
  await seedOrganization("Attachment-test-password");
  const departmentId = (
    await database().query("SELECT id FROM departments WHERE name='研发部'")
  ).rows[0].id;
  const adminId = (
    await database().query("SELECT id FROM users WHERE username='admin'")
  ).rows[0].id;
  for (const name of ["admin", "owner", "head", "finance", "pending"]) {
    const id =
      name === "admin"
        ? adminId
        : (
            await database().query(
              `INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
    SELECT $1::text,$1::text,$1::text||'@example.invalid',password_hash,$2,CASE WHEN $1::text='pending' THEN NULL ELSE $2::uuid END,
     CASE WHEN $1::text='pending' THEN 'pending' ELSE 'active' END FROM users WHERE id=$3 RETURNING id`,
              [name, departmentId, adminId],
            )
          ).rows[0].id;
    if (name !== "admin")
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
        [id],
      );
    if (name === "head" || name === "finance")
      await database().query(
        "INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)",
        [id, name === "head" ? "department_head" : "finance_approver"],
      );
    const token = randomBytes(32).toString("hex");
    await database().query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
      [tokenHash(token), id],
    );
    people[name] = { id, token };
  }
});
afterAll(async () => {
  process.env.ATTACHMENT_STORAGE_DIR = storage;
  await closeDatabase();
  await rm(storage, { recursive: true, force: true });
});

test("JPEG/PNG/PDF 绑定同单费用明细，元数据、原字节与安全预览/下载头完整", async () => {
  const app = await draft();
  let version = 1,
    totalBytes = 0;
  for (const [bytes, name, type] of [
    [png, "费用明细.png", "image/png"],
    [jpeg, "截图.jpg", "image/jpeg"],
    [pdf, "证明.pdf", "application/pdf"],
  ] as const) {
    const response = await upload(
      app.id,
      app.items[0].id,
      version,
      bytes,
      name,
      type,
    );
    expect(response.status).toBe(201);
    const { attachment, version: next } = (await response.json()).data;
    version++;
    expect(next).toBe(version);
    expect(attachment).toMatchObject({
      appId: app.id,
      itemId: app.items[0].id,
      uploaderId: people.owner.id,
      originalName: name,
      mimeType: type,
      sizeBytes: bytes.length,
    });
    expect(attachment.storageKey).toBeUndefined();
    expect(attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const mode of ["inline", "attachment"]) {
      const read = await content(
        app.id,
        attachment.id,
        people.owner.token,
        `?disposition=${mode}`,
      );
      expect(read.status).toBe(200);
      expect(read.headers.get("content-type")).toBe(type);
      expect(read.headers.get("content-disposition")).toContain(`${mode};`);
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect(read.headers.get("x-content-type-options")).toBe("nosniff");
      expect(read.headers.get("content-security-policy")).toContain("sandbox");
      expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
    }
    expect(
      (
        await getReimbursementAttachmentContent(
          people.owner.token,
          app.id,
          attachment.id,
        )
      ).attachment,
    ).not.toHaveProperty("storageKey");
    totalBytes += bytes.length;
  }
  expect((await (await list(app.id)).json()).data).toMatchObject({
    version: 4,
    status: "draft",
    totalBytes,
  });
  expect(await files()).toHaveLength(3);
  const current = await getReimbursementDraft(people.owner.token, app.id);
  expect(current.items).toEqual(app.items);
  expect(current.totalAmount).toBe("200.00");
});
test("跨报销/不存在/其他业务费用明细拒绝，差旅附件 API 不获得报销权限", async () => {
  const app = await draft(),
    other = await draft();
  const saved = await uploaded(app);
  expect((await upload(app.id, other.items[0].id, 2)).status).toBe(404);
  expect((await upload(app.id, randomUUID(), 2)).status).toBe(404);
  expect((await content(other.id, saved.attachment.id)).status).toBe(404);
  expect((await remove(other.id, saved.attachment.id, 1)).status).toBe(404);
  const travel = await createTravelDraft(
    people.owner.token,
    travelDraftSchema.parse({}),
  );
  expect((await upload(travel.id, app.items[0].id)).status).toBe(404);
  expect(
    (await travelContent(request(), context(app.id, saved.attachment.id)))
      .status,
  ).toBe(404);
  expect(await files()).toHaveLength(1);
});
test("管理员/负责人/财务无本人草稿附件权限，匿名/待确认/失效身份拒绝且不读取正文", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  for (const who of ["admin", "head", "finance"]) {
    const token = people[who].token;
    expect((await list(app.id, token)).status).toBe(404);
    expect((await content(app.id, saved.attachment.id, token)).status).toBe(
      404,
    );
    expect((await remove(app.id, saved.attachment.id, 2, token)).status).toBe(
      404,
    );
    const req = request("POST", "invalid multipart", token);
    expect(
      (await uploadHandler(req, context(app.id, undefined, app.items[0].id)))
        .status,
    ).toBe(404);
    expect(req.bodyUsed).toBe(false);
  }
  expect((await list(app.id, "")).status).toBe(401);
  expect((await list(app.id, people.pending.token)).status).toBe(403);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.owner.id],
  );
  expect((await content(app.id, saved.attachment.id)).status).toBe(401);
});
test("严格 multipart/同源/查询校验，文件伪装与单件大小拒绝不增版本", async () => {
  const app = await draft(),
    ctx = context(app.id, undefined, app.items[0].id);
  for (const key of ["itemId", "applicantId", "file", "version"]) {
    const body = form();
    body.append(key, "forged");
    expect((await uploadHandler(request("POST", body), ctx)).status).toBe(400);
  }
  expect(
    (
      await uploadHandler(
        request("POST", form(), "", {
          Cookie: `approval_session=${people.owner.token}`,
        }),
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await uploadHandler(
        request("POST", form(), people.owner.token, {
          Origin: "https://evil.invalid",
        }),
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await uploadHandler(
        request("POST", "{}", people.owner.token, {
          "Content-Type": "application/json",
        }),
        ctx,
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await uploadHandler(
        request("POST", form(), people.owner.token, {
          "Content-Length": String(maxAttachmentBytes + 65537),
        }),
        ctx,
      )
    ).status,
  ).toBe(413);
  for (const [bytes, name, type, status] of [
    [Buffer.from("not image"), "bad.png", "image/png", 415],
    [png, "bad.pdf", "application/pdf", 415],
    [Buffer.alloc(0), "empty.png", "image/png", 400],
    [Buffer.alloc(maxAttachmentBytes + 1), "large.png", "image/png", 413],
  ] as const)
    expect(
      (await upload(app.id, app.items[0].id, 1, bytes, name, type)).status,
    ).toBe(status);
  const value = await uploaded(app);
  for (const search of [
    "?disposition=inline&disposition=attachment",
    "?__proto__=x",
    "?disposition=other",
  ])
    expect(
      (await content(app.id, value.attachment.id, people.owner.token, search))
        .status,
    ).toBe(400);
  expect(
    (await getReimbursementDraft(people.owner.token, app.id)).version,
  ).toBe(2);
  expect(await files()).toHaveLength(1);
});
test("费用明细编辑与换序保留附件，省略带附件费用明细拒绝整单保存，显式删除后才可移除费用明细", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  const changed = await replaceReimbursementDraft(
    people.owner.token,
    app.id,
    replaceReimbursementDraftSchema.parse({
      version: 2,
      title: "换序",
      items: [app.items[1], { ...app.items[0], purpose: "更正用途" }],
    }),
  );
  expect(changed.version).toBe(3);
  expect((await (await list(app.id)).json()).data.items).toEqual([
    saved.attachment,
  ]);
  await expect(
    replaceReimbursementDraft(
      people.owner.token,
      app.id,
      replaceReimbursementDraftSchema.parse({ version: 3, title: "不应保存" }),
    ),
  ).rejects.toMatchObject({ code: "ITEM_HAS_ATTACHMENTS", status: 409 });
  expect(await getReimbursementDraft(people.owner.token, app.id)).toEqual(
    changed,
  );
  expect((await remove(app.id, saved.attachment.id, 3)).status).toBe(200);
  const cleared = await replaceReimbursementDraft(
    people.owner.token,
    app.id,
    replaceReimbursementDraftSchema.parse({ version: 4 }),
  );
  expect(cleared.items).toEqual([]);
  expect(await files()).toEqual([]);
});
test("并发上传使用同一申请版本，整单九件配额跨费用明细累计", async () => {
  const app = await draft();
  const race = await Promise.all(
    app.items.map((item) => upload(app.id, item.id)),
  );
  expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
  for (let version = 2; version <= 9; version++)
    await uploaded(app, version, version % 2);
  const result = await upload(app.id, app.items[1].id, 10);
  expect(result.status).toBe(413);
  expect((await (await list(app.id)).json()).data.items).toHaveLength(9);
  expect(await files()).toHaveLength(9);
});
test("整单 50 MiB 配额来自数据库，不按单个费用明细分开计算", async () => {
  const app = await draft();
  // Metadata-only quota fixture; content integrity is exercised separately with real bytes.
  for (let i = 0; i < 5; i++)
    await database().query(
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,reimbursement_item_id) VALUES ($1,$2,$3,'item.png','image/png',10485760,$4,$5)",
      [
        app.id,
        people.owner.id,
        randomUUID(),
        "0".repeat(64),
        app.items[i % 2].id,
      ],
    );
  expect((await upload(app.id, app.items[1].id)).status).toBe(413);
  expect((await (await list(app.id)).json()).data.totalBytes).toBe(
    50 * 1024 * 1024,
  );
  expect(await files()).toEqual([]);
});
test("上传与删除费用明细/整张草稿竞争只能一次改变版本，不遗留多余文件", async () => {
  for (const action of ["item", "draft"]) {
    const app = await draft();
    const mutation =
      action === "item"
        ? replaceReimbursementDraft(
            people.owner.token,
            app.id,
            replaceReimbursementDraftSchema.parse({ version: 1, items: [] }),
          )
        : deleteReimbursementDraft(people.owner.token, app.id, 1);
    const [file, result] = await Promise.all([
      upload(app.id, app.items[0].id),
      mutation.then(
        () => 200,
        (error) => error.status,
      ),
    ]);
    expect((file.status === 201 ? 1 : 0) + (result === 200 ? 1 : 0)).toBe(1);
    expect([200, 404, 409]).toContain(result);
    expect([201, 404, 409]).toContain(file.status);
  }
  await collectAttachmentGarbage();
  expect((await files()).length).toBe(
    (await database().query("SELECT count(*)::int AS n FROM attachments"))
      .rows[0].n,
  );
});
test("上传元数据失败回滚版本且回收孤儿，不破坏其他仍引用文件", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  await database().query(
    "ALTER TABLE applications ADD CONSTRAINT test_reimbursement_file_version CHECK(version<3) NOT VALID",
  );
  try {
    expect((await upload(app.id, app.items[1].id, 2)).status).toBe(500);
  } finally {
    await database().query(
      "ALTER TABLE applications DROP CONSTRAINT test_reimbursement_file_version",
    );
  }
  expect(
    (await getReimbursementDraft(people.owner.token, app.id)).version,
  ).toBe(2);
  expect(await files()).toHaveLength(1);
  expect(
    Buffer.from(
      await (await content(app.id, saved.attachment.id)).arrayBuffer(),
    ),
  ).toEqual(png);
});
test("删除附件失败完整回滚并保留文件，旧版本拒绝，成功后回收", async () => {
  const app = await draft(),
    saved = await uploaded(app),
    path = await pathFor(saved.attachment.id);
  await database().query(
    "ALTER TABLE applications ADD CONSTRAINT test_reimbursement_file_delete CHECK(version<3) NOT VALID",
  );
  try {
    expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(500);
    expect(await readFile(path)).toEqual(png);
  } finally {
    await database().query(
      "ALTER TABLE applications DROP CONSTRAINT test_reimbursement_file_delete",
    );
  }
  expect((await remove(app.id, saved.attachment.id, 1)).status).toBe(409);
  expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(200);
  expect(await files()).toEqual([]);
  expect((await (await list(app.id)).json()).data.version).toBe(3);
});
test("整张草稿删除失败保留费用明细与文件，成功按引用顺序清理并回收", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  await database().query(
    "CREATE TABLE test_reimbursement_file_reference(app_id UUID REFERENCES applications(id))",
  );
  await database().query(
    "INSERT INTO test_reimbursement_file_reference VALUES ($1)",
    [app.id],
  );
  try {
    await expect(
      deleteReimbursementDraft(people.owner.token, app.id, 2),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await (await list(app.id)).json()).data.items).toHaveLength(1);
    expect(await readFile(await pathFor(saved.attachment.id))).toEqual(png);
  } finally {
    await database().query("DROP TABLE test_reimbursement_file_reference");
  }
  await deleteReimbursementDraft(people.owner.token, app.id, 2);
  expect(await files()).toEqual([]);
  for (const table of [
    "attachments",
    "reimbursement_items",
    "reimbursement_requests",
  ])
    expect(
      (await database().query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n,
    ).toBe(0);
});
test("数据库阻止跨费用明细/申请关联、无费用明细上传、元数据改写和非草稿删除", async () => {
  const app = await draft(),
    other = await draft(),
    saved = await uploaded(app);
  const insert = (itemId: string | null, owner = people.owner.id) =>
    database().query(
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,reimbursement_item_id) VALUES ($1,$2,$3,'item.png','image/png',1,$4,$5)",
      [app.id, owner, randomUUID(), "0".repeat(64), itemId],
    );
  await expect(insert(other.items[0].id)).rejects.toMatchObject({
    code: "23503",
  });
  await expect(insert(null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(app.items[0].id, people.head.id)).rejects.toMatchObject({
    code: "23514",
  });
  await expect(
    database().query(
      "UPDATE attachments SET reimbursement_item_id=$2 WHERE id=$1",
      [saved.attachment.id, app.items[1].id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("DELETE FROM reimbursement_items WHERE id=$1", [
      app.items[0].id,
    ]),
  ).rejects.toMatchObject({ code: "23503" });
  await database().query(
    "UPDATE applications SET status='pending',submitted_at=now() WHERE id=$1",
    [app.id],
  );
  expect((await list(app.id)).status).toBe(409);
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  expect((await upload(app.id, app.items[0].id, 2)).status).toBe(409);
  expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(409);
  await expect(
    database().query("DELETE FROM attachments WHERE app_id=$1", [app.id]),
  ).rejects.toMatchObject({ code: "23514" });
  expect(await readFile(await pathFor(saved.attachment.id))).toEqual(png);
});
test("文件缺失或内容损坏返回 409，列表元数据仍保留", async () => {
  const app = await draft(),
    saved = await uploaded(app),
    path = await pathFor(saved.attachment.id);
  await writeFile(path, Buffer.alloc(png.length));
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  await rm(path);
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  expect((await (await list(app.id)).json()).data.items).toHaveLength(1);
});
test("共享回收锁等待未完成文件事务，提交后保留引用对象并删除孤儿", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  const client = await database().connect();
  const orphan = randomUUID();
  const inFlight = randomUUID();
  let gc: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN");
    await lockAttachmentStorage(client);
    await client.query("SELECT id FROM applications WHERE id=$1 FOR UPDATE", [
      app.id,
    ]);
    await writeAttachmentObject(orphan, png);
    await writeAttachmentObject(inFlight, png);
    await client.query(
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,reimbursement_item_id) VALUES ($1,$2,$3,'new.png','image/png',$4,$5,$6)",
      [
        app.id,
        people.owner.id,
        inFlight,
        png.length,
        saved.attachment.sha256,
        app.items[1].id,
      ],
    );
    await client.query(
      "UPDATE applications SET version=version+1 WHERE id=$1",
      [app.id],
    );
    let done = false;
    gc = collectAttachmentGarbage().then((value) => {
      done = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(done).toBe(false);
    await client.query("COMMIT");
    await gc;
    expect(await files()).toHaveLength(2);
    expect(await readFile(join(storage, `${inFlight}.blob`))).toEqual(png);
    expect(await readFile(await pathFor(saved.attachment.id))).toEqual(png);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await gc;
  }
});
test("重复迁移/连接重建保留费用明细关联、版本、元数据和原字节", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  const before = (await (await list(app.id)).json()).data;
  await migrate();
  await closeDatabase();
  expect((await (await list(app.id)).json()).data).toEqual(before);
  expect(
    Buffer.from(
      await (await content(app.id, saved.attachment.id)).arrayBuffer(),
    ),
  ).toEqual(png);
});

test("票据号码可选并规范化，拒绝重复字段/File/控制字符/超长，不允许旧业务接收", async () => {
  const app = await draft();
  const ctx = context(app.id, undefined, app.items[0].id);
  for (const value of [
    "a".repeat(101),
    "A\u0000B",
    "A\u200bB",
    new File(["x"], "number.txt"),
  ]) {
    const body = form();
    body.set("receiptNumber", value);
    expect((await uploadHandler(request("POST", body), ctx)).status).toBe(400);
  }
  const duplicate = form();
  duplicate.append("receiptNumber", "A");
  duplicate.append("receiptNumber", "B");
  expect((await uploadHandler(request("POST", duplicate), ctx)).status).toBe(
    400,
  );
  const body = form();
  body.set("receiptNumber", "  INV-2026-001  ");
  const saved = (await (await uploadHandler(request("POST", body), ctx)).json())
    .data;
  expect(saved.attachment.receiptNumber).toBe("INV-2026-001");
  const second = await uploaded(app, 2, 1);
  expect(second.attachment.receiptNumber).toBe("");
  expect(
    (await (await list(app.id)).json()).data.items.map(
      (x: { receiptNumber: string }) => x.receiptNumber,
    ),
  ).toEqual(["INV-2026-001", ""]);
  const { attachmentForm } = await import("../src/server/attachment-http");
  await expect(attachmentForm(request("POST", body))).rejects.toMatchObject({
    status: 400,
    code: "INVALID_MULTIPART",
  });
  await expect(
    database().query(
      "UPDATE attachments SET receipt_number='changed' WHERE id=$1",
      [saved.attachment.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

test("同一记录不能绑到第二条明细；同一号码或相同文件的新记录不冒充跨单重复检测", async () => {
  const app = await draft();
  const saved = await uploaded(app);
  await expect(
    database().query(
      "UPDATE attachments SET reimbursement_item_id=$2 WHERE id=$1",
      [saved.attachment.id, app.items[1].id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const body = form(2);
  body.set("attachmentId", saved.attachment.id);
  expect(
    (
      await uploadHandler(
        request("POST", body),
        context(app.id, undefined, app.items[1].id),
      )
    ).status,
  ).toBe(400);
  const second = await uploaded(app, 2, 1);
  expect(second.attachment.id).not.toBe(saved.attachment.id);
  expect(second.attachment.sha256).toBe(saved.attachment.sha256);
  const rows = (await (await list(app.id)).json()).data.items;
  expect(new Set(rows.map((row: { id: string }) => row.id)).size).toBe(2);
  expect(rows.map((row: { itemId: string }) => row.itemId)).toEqual(
    app.items.map((row) => row.id),
  );
});

test("报销元数据不能移入其他业务，外业务不能带票据明细或号码，旧附件原样保留", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  const travel = await createTravelDraft(
    people.owner.token,
    travelDraftSchema.parse({}),
  );
  await expect(
    database().query(
      "UPDATE attachments SET app_id=$2,reimbursement_item_id=NULL,receipt_number='' WHERE id=$1",
      [saved.attachment.id, travel.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  for (const [itemId, number] of [
    [app.items[0].id, ""],
    [null, "INV-1"],
  ]) {
    await expect(
      database().query(
        "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,reimbursement_item_id,receipt_number) VALUES ($1,$2,$3,'x.png','image/png',1,$4,$5,$6)",
        [
          travel.id,
          people.owner.id,
          randomUUID(),
          "0".repeat(64),
          itemId,
          number,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  const { purchaseAttachmentContentHandler } =
    await import("../src/server/purchase-attachment-handlers");
  expect(
    (
      await purchaseAttachmentContentHandler(
        request(),
        context(app.id, saved.attachment.id),
      )
    ).status,
  ).toBe(404);
});

test("版本上限拒绝上传和单件删除，整单删除仍可回收；无票标记不免除上传权限", async () => {
  const app = await createReimbursementDraft(
    people.owner.token,
    reimbursementDraftSchema.parse({ items: [{ noReceipt: true }] }),
  );
  const saved = await uploaded(app);
  expect(
    (await getReimbursementDraft(people.owner.token, app.id)).items[0]
      .noReceipt,
  ).toBe(true);
  await database().query(
    "UPDATE applications SET version=2147483647 WHERE id=$1",
    [app.id],
  );
  expect((await upload(app.id, app.items[0].id, 2147483647)).status).toBe(409);
  expect((await remove(app.id, saved.attachment.id, 2147483647)).status).toBe(
    409,
  );
  expect(await files()).toHaveLength(1);
  await deleteReimbursementDraft(people.owner.token, app.id, 2147483647);
  expect(await files()).toEqual([]);
});
