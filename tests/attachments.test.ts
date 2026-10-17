import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { beforeAll, beforeEach, afterAll, expect, test } from "vitest";
import { database, closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { tokenHash } from "../src/server/auth";
import { travelDraftSchema } from "../src/lib/travel";
import { maxAttachmentBytes } from "../src/lib/attachments";
import { createTravelDraft, deleteTravelDraft } from "../src/server/travel";
import { submitTravelDraft } from "../src/server/travel-submission";
import { decideTravelTask } from "../src/server/travel-actions";
import { validateAttachment } from "../src/server/attachment-validation";
import {
  collectAttachmentGarbage,
  lockAttachmentStorage,
  writeAttachmentObject,
} from "../src/server/attachment-storage";
import {
  uploadAttachmentHandler,
  attachmentsHandler,
  deleteAttachmentHandler,
  attachmentContentHandler,
} from "../src/server/attachment-handlers";

const origin = "http://localhost:3000";
const storage = resolve("tmp/attachments-vitest-test");
const people: Record<string, { id: string; token: string }> = {};
let png: Buffer, jpeg: Buffer, pdf: Buffer;
const context = (id: string, attachmentId?: string) => ({
  params: Promise.resolve({ id, attachmentId }),
});
function request(
  method = "GET",
  body?: BodyInit,
  token = people.owner.token,
  headers: Record<string, string> = {},
  search = "",
) {
  return new Request(`${origin}/api/travel-applications/files${search}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}
function form(bytes = png, name = "行程.png", type = "image/png", version = 1) {
  const data = new FormData();
  data.set("file", new File([new Uint8Array(bytes)], name, { type }));
  data.set("version", String(version));
  return data;
}
const upload = (
  id: string,
  version = 1,
  bytes = png,
  name = "行程.png",
  type = "image/png",
  token = people.owner.token,
) =>
  uploadAttachmentHandler(
    request("POST", form(bytes, name, type, version), token),
    context(id),
  );
const list = (id: string, token = people.owner.token) =>
  attachmentsHandler(request("GET", undefined, token), context(id));
const content = (
  id: string,
  fileId: string,
  token = people.owner.token,
  search = "",
) =>
  attachmentContentHandler(
    request("GET", undefined, token, {}, search),
    context(id, fileId),
  );
const remove = (
  id: string,
  fileId: string,
  version: number,
  token = people.owner.token,
) =>
  deleteAttachmentHandler(
    request("DELETE", JSON.stringify({ version }), token, {
      "Content-Type": "application/json",
    }),
    context(id, fileId),
  );
async function draft() {
  return createTravelDraft(
    people.owner.token,
    travelDraftSchema.parse({
      title: "附件验收",
      departure: "杭州",
      destination: "上海",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      purpose: "交流",
      transportation: "高铁",
      budget: "100.00",
    }),
  );
}
async function uploaded(id: string, version = 1) {
  const result = await upload(id, version);
  expect(result.status).toBe(201);
  return (await result.json()).data;
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

test("JPEG/PNG/PDF 上传保留原字节与元数据，列表及受控预览/下载可读", async () => {
  const app = await draft();
  let version = 1,
    totalBytes = 0;
  for (const [bytes, name, type] of [
    [png, "行程.png", "image/png"],
    [jpeg, "photo.JPG", "image/jpeg"],
    [pdf, "说明.pdf", "application/pdf"],
  ] as const) {
    const response = await upload(app.id, version, bytes, name, type);
    expect(response.status).toBe(201);
    const value = (await response.json()).data;
    version++;
    expect(value).toMatchObject({
      version,
      attachment: {
        appId: app.id,
        uploaderId: people.owner.id,
        originalName: name,
        mimeType: type,
        sizeBytes: bytes.length,
      },
    });
    expect(value.attachment.storageKey).toBeUndefined();
    expect(value.attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const mode of ["inline", "attachment"]) {
      const binary = await content(
        app.id,
        value.attachment.id,
        people.owner.token,
        `?disposition=${mode}`,
      );
      expect(binary.status).toBe(200);
      expect(binary.headers.get("content-type")).toBe(type);
      expect(binary.headers.get("content-disposition")).toContain(`${mode};`);
      expect(binary.headers.get("cache-control")).toBe("no-store");
      expect(binary.headers.get("x-content-type-options")).toBe("nosniff");
      expect(binary.headers.get("content-security-policy")).toContain(
        "sandbox",
      );
      expect(Buffer.from(await binary.arrayBuffer())).toEqual(bytes);
    }
    totalBytes += bytes.length;
  }
  const result = (await (await list(app.id)).json()).data;
  expect(result).toMatchObject({ version: 4, status: "draft", totalBytes });
  expect(result.items).toHaveLength(3);
  expect(await files()).toHaveLength(3);
});

test("伪装扩展名、MIME、假签名、损坏与空文件被拒绝，文件名不能逃逸路径", async () => {
  const app = await draft();
  for (const [bytes, name, type] of [
    [Buffer.from("<script>x</script>"), "fake.png", "image/png"],
    [png, "fake.pdf", "application/pdf"],
    [png, "a.png", "image/jpeg"],
    [png.subarray(0, 20), "broken.png", "image/png"],
    [Buffer.from("%PDF-1.7\n%%EOF"), "fake.pdf", "application/pdf"],
    [Buffer.from("<svg/>"), "a.svg", "image/svg+xml"],
  ] as const)
    expect((await upload(app.id, 1, bytes, name, type)).status).toBe(415);
  expect((await upload(app.id, 1, Buffer.alloc(0))).status).toBe(400);
  for (const name of ["../a.png", "a\\b.png", "a\r\nb.png", "a\u202epng.png"])
    await expect(
      validateAttachment(png, name, "image/png"),
    ).rejects.toBeDefined();
  expect(await files()).toEqual([]);
  expect((await (await list(app.id)).json()).data.version).toBe(1);
  expect(
    (await upload(app.id, 1, png, "native.png", "application/octet-stream"))
      .status,
  ).toBe(201);
});

test("单件 10 MiB 边界及请求正文实际流量限制，不只相信 Content-Length", async () => {
  const app = await draft();
  const eof = pdf.lastIndexOf("%%EOF");
  const exact = Buffer.concat([
    pdf.subarray(0, eof),
    Buffer.alloc(maxAttachmentBytes - pdf.length, 32),
    pdf.subarray(eof),
  ]);
  expect(exact.length).toBe(maxAttachmentBytes);
  expect(
    (await upload(app.id, 1, exact, "large.pdf", "application/pdf")).status,
  ).toBe(201);
  expect(
    (
      await upload(
        app.id,
        2,
        Buffer.concat([exact, Buffer.from(" ")]),
        "large.pdf",
        "application/pdf",
      )
    ).status,
  ).toBe(413);
  const requestBody = Buffer.alloc(maxAttachmentBytes + 64 * 1024 + 1, 32);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", requestBody, people.owner.token, {
          "Content-Type": "multipart/form-data; boundary=x",
        }),
        context(app.id),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", form(), people.owner.token, {
          "Content-Length": String(requestBody.length),
        }),
        context(app.id),
      )
    ).status,
  ).toBe(413);
}, 30000);

test("仅接受单文件和版本，拒绝伪造字段、重复文件、无效版本与来源", async () => {
  const app = await draft();
  for (const extra of ["uploaderId", "appId", "storageKey", "sizeBytes"]) {
    const body = form();
    body.set(extra, "x");
    expect(
      (await uploadAttachmentHandler(request("POST", body), context(app.id)))
        .status,
    ).toBe(400);
  }
  const duplicate = form();
  duplicate.append(
    "file",
    new File([new Uint8Array(png)], "second.png", { type: "image/png" }),
  );
  expect(
    (await uploadAttachmentHandler(request("POST", duplicate), context(app.id)))
      .status,
  ).toBe(400);
  expect((await upload(app.id, 0)).status).toBe(400);
  expect((await upload(app.id, 2)).status).toBe(409);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", form(), "", {
          Cookie: `approval_session=${people.owner.token}`,
        }),
        context(app.id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", form(), people.owner.token, {
          Origin: "https://example.invalid",
        }),
        context(app.id),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", "{}", people.owner.token, {
          "Content-Type": "application/json",
        }),
        context(app.id),
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", undefined, "0".repeat(64)),
        context(app.id),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await uploadAttachmentHandler(
        request("POST", form(), "", {
          Cookie: `approval_session=${people.owner.token}`,
          Origin: origin,
        }),
        context(app.id),
      )
    ).status,
  ).toBe(201);
});

test("草稿仅本人可读；已提交当前/已办人员可读，管理员与未激活人员无附件权限", async () => {
  const app = await draft();
  const saved = await uploaded(app.id);
  const id = saved.attachment.id;
  for (const token of [
    people.head.token,
    people.finance.token,
    people.admin.token,
  ]) {
    expect((await list(app.id, token)).status).toBe(404);
    expect((await content(app.id, id, token)).status).toBe(404);
    expect(
      (await upload(app.id, 2, png, "a.png", "image/png", token)).status,
    ).toBe(404);
    expect((await remove(app.id, id, 2, token)).status).toBe(404);
  }
  expect((await list(app.id, people.pending.token)).status).toBe(403);
  const submitted = await submitTravelDraft(people.owner.token, app.id, 2);
  expect((await content(app.id, id, people.head.token)).status).toBe(200);
  expect((await content(app.id, id, people.finance.token)).status).toBe(404);
  await decideTravelTask(people.head.token, app.id, submitted.tasks[0].id, {
    version: 3,
    decision: "approve",
    opinion: "",
  });
  expect((await content(app.id, id, people.head.token)).status).toBe(200);
  expect((await content(app.id, id, people.finance.token)).status).toBe(200);
  expect((await content(app.id, id, people.admin.token)).status).toBe(404);
  await database().query(
    "UPDATE users SET registration_status='disabled' WHERE id=$1",
    [people.head.id],
  );
  expect((await content(app.id, id, people.head.token)).status).toBe(401);
  const other = await draft();
  expect((await content(other.id, id)).status).toBe(404);
  expect((await content(app.id, randomUUID())).status).toBe(404);
});

test("提交后附件冻结，不能删除/替换或删掉原申请，原字节保留", async () => {
  const app = await draft();
  const saved = await uploaded(app.id);
  await submitTravelDraft(people.owner.token, app.id, 2);
  expect((await upload(app.id, 3)).status).toBe(409);
  expect((await remove(app.id, saved.attachment.id, 3)).status).toBe(409);
  await expect(
    deleteTravelDraft(people.owner.token, app.id, 3),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    Buffer.from(
      await (await content(app.id, saved.attachment.id)).arrayBuffer(),
    ),
  ).toEqual(png);
});

test("并发上传和数量限制由申请行锁与版本保护，不留下多余文件", async () => {
  const app = await draft();
  const concurrent = await Promise.all([upload(app.id), upload(app.id)]);
  expect(concurrent.map((r) => r.status).sort()).toEqual([201, 409]);
  for (let version = 2; version <= 9; version++)
    expect((await upload(app.id, version)).status).toBe(201);
  expect((await upload(app.id, 10)).status).toBe(413);
  expect((await (await list(app.id)).json()).data.items).toHaveLength(9);
  expect(await files()).toHaveLength(9);
});

test("累计 50 MiB 限制以数据库统计为准，不接受客户端伪造容量", async () => {
  const app = await draft();
  for (let version = 1; version <= 5; version++)
    await uploaded(app.id, version);
  // Quota fixture: count/aggregate checks are independent of content-integrity tests above.
  await database().query(
    "UPDATE attachments SET size_bytes=10485760 WHERE app_id=$1",
    [app.id],
  );
  expect((await upload(app.id, 6)).status).toBe(413);
  expect((await (await list(app.id)).json()).data).toMatchObject({
    totalBytes: 50 * 1024 * 1024,
    version: 6,
  });
});

test("上传与提交或删除草稿竞争，只有一个版本变化成功", async () => {
  for (const action of ["submit", "delete"]) {
    const app = await draft();
    const mutation =
      action === "submit"
        ? submitTravelDraft(people.owner.token, app.id, 1)
        : deleteTravelDraft(people.owner.token, app.id, 1);
    const [uploadResult, other] = await Promise.all([
      upload(app.id),
      mutation.then(
        () => 200,
        (error) => error.status,
      ),
    ]);
    expect(
      (uploadResult.status === 201 ? 1 : 0) + (other === 200 ? 1 : 0),
    ).toBe(1);
    expect([200, 404, 409]).toContain(other);
    expect([201, 404, 409]).toContain(uploadResult.status);
  }
  await collectAttachmentGarbage();
  expect((await files()).length).toBe(
    (await database().query("SELECT count(*)::int AS count FROM attachments"))
      .rows[0].count,
  );
});

test("删除附件失败回滚保留文件，成功后递增版本并回收文件", async () => {
  const app = await draft();
  const saved = await uploaded(app.id);
  const path = await pathFor(saved.attachment.id);
  await database().query(
    "ALTER TABLE applications ADD CONSTRAINT test_attachment_version CHECK(version<3) NOT VALID",
  );
  try {
    expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(500);
    expect(await readFile(path)).toEqual(png);
    expect((await (await list(app.id)).json()).data.items).toHaveLength(1);
  } finally {
    await database().query(
      "ALTER TABLE applications DROP CONSTRAINT test_attachment_version",
    );
  }
  expect((await remove(app.id, saved.attachment.id, 1)).status).toBe(409);
  expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(200);
  expect(await files()).toEqual([]);
  expect((await (await list(app.id)).json()).data.version).toBe(3);
});

test("删除草稿失败不丢附件，成功在同一事务删元数据并回收原文件", async () => {
  const app = await draft();
  const saved = await uploaded(app.id);
  await database().query(
    "CREATE TABLE test_attachment_reference(app_id UUID REFERENCES applications(id))",
  );
  await database().query("INSERT INTO test_attachment_reference VALUES ($1)", [
    app.id,
  ]);
  try {
    await expect(
      deleteTravelDraft(people.owner.token, app.id, 2),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await content(app.id, saved.attachment.id)).status).toBe(200);
  } finally {
    await database().query("DROP TABLE test_attachment_reference");
  }
  await deleteTravelDraft(people.owner.token, app.id, 2);
  expect(await files()).toEqual([]);
  expect((await list(app.id)).status).toBe(404);
});

test("元数据写入失败后回收未引用文件，不删除已有有效对象", async () => {
  const app = await draft();
  await uploaded(app.id);
  await database().query(
    "ALTER TABLE attachments ADD CONSTRAINT test_reject_file CHECK(original_name<>'fail.png') NOT VALID",
  );
  try {
    expect((await upload(app.id, 2, png, "fail.png")).status).toBe(500);
    expect(await files()).toHaveLength(1);
    expect((await (await list(app.id)).json()).data).toMatchObject({
      version: 2,
    });
  } finally {
    await database().query(
      "ALTER TABLE attachments DROP CONSTRAINT test_reject_file",
    );
  }
});

test("存储不可写时数据库不产生附件或新版本；public 目录不可配置为存储", async () => {
  const app = await draft();
  const invalid = join(storage, "not-directory");
  await writeFile(invalid, "fixture");
  process.env.ATTACHMENT_STORAGE_DIR = invalid;
  try {
    expect((await upload(app.id)).status).toBe(500);
  } finally {
    process.env.ATTACHMENT_STORAGE_DIR = storage;
  }
  process.env.ATTACHMENT_STORAGE_DIR = resolve("public");
  try {
    expect((await upload(app.id)).status).toBe(500);
  } finally {
    process.env.ATTACHMENT_STORAGE_DIR = storage;
  }
  expect((await (await list(app.id)).json()).data).toMatchObject({
    items: [],
    version: 1,
  });
});

test("缺失、篡改或符号链接附件拒绝下载与提交；恢复原件后可提交", async () => {
  const app = await draft();
  const saved = await uploaded(app.id);
  const path = await pathFor(saved.attachment.id);
  await rm(path);
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  await expect(
    submitTravelDraft(people.owner.token, app.id, 2),
  ).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
  await writeFile(path, Buffer.alloc(png.length, 0));
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  await rm(path);
  const other = join(storage, "unrelated.txt");
  await writeFile(other, "private fixture");
  await symlink(other, path);
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  await rm(path);
  await writeFile(path, png);
  expect(
    (await submitTravelDraft(people.owner.token, app.id, 2)).application.status,
  ).toBe("pending");
});

test("回收只删未引用 UUID 对象，保留已提交文件与非对象文件；重连和迁移不丢附件", async () => {
  const app = await draft();
  const saved = await uploaded(app.id);
  await submitTravelDraft(people.owner.token, app.id, 2);
  const orphan = randomUUID();
  await writeAttachmentObject(orphan, png);
  await writeFile(join(storage, "keep.txt"), "keep");
  const result = await collectAttachmentGarbage();
  expect(result).toEqual({ removed: 1, retained: 1 });
  expect(await readFile(join(storage, "keep.txt"), "utf8")).toBe("keep");
  await closeDatabase();
  await migrate();
  expect(
    Buffer.from(
      await (await content(app.id, saved.attachment.id)).arrayBuffer(),
    ),
  ).toEqual(png);
});

test("回收等待正在写入的上传事务，不能把未提交但即将引用的文件删掉", async () => {
  const app = await draft();
  const client = await database().connect();
  const key = randomUUID();
  let cleanup: ReturnType<typeof collectAttachmentGarbage> | undefined;
  try {
    await client.query("BEGIN");
    await lockAttachmentStorage(client);
    await writeAttachmentObject(key, png);
    cleanup = collectAttachmentGarbage();
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=72004 AND NOT granted) AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBe(true);
    const validated = await validateAttachment(png, "live.png", "image/png");
    await client.query(
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256) VALUES ($1,$2,$3,'live.png','image/png',$4,$5)",
      [app.id, people.owner.id, key, png.length, validated.sha256],
    );
    await client.query("COMMIT");
    expect(await cleanup).toEqual({ removed: 0, retained: 1 });
    expect(await readFile(join(storage, `${key}.blob`))).toEqual(png);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await cleanup;
  }
});
