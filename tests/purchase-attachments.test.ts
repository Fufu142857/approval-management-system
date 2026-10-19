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
  purchaseDraftSchema,
  replacePurchaseDraftSchema,
} from "../src/lib/purchase";
import { travelDraftSchema } from "../src/lib/travel";
import { createTravelDraft } from "../src/server/travel";
import { attachmentContentHandler as travelContent } from "../src/server/attachment-handlers";
import { maxAttachmentBytes } from "../src/lib/attachments";
import {
  createPurchaseDraft,
  getPurchaseDraft,
  replacePurchaseDraft,
  deletePurchaseDraft,
} from "../src/server/purchase";
import {
  collectAttachmentGarbage,
  lockAttachmentStorage,
  writeAttachmentObject,
} from "../src/server/attachment-storage";
import {
  uploadPurchaseAttachmentHandler as uploadHandler,
  purchaseAttachmentsHandler as listHandler,
  deletePurchaseAttachmentHandler as removeHandler,
  purchaseAttachmentContentHandler as contentHandler,
} from "../src/server/purchase-attachment-handlers";
import { getPurchaseAttachmentContent } from "../src/server/purchase-attachments";
const origin = "http://localhost:3000";
const storage = resolve("tmp/attachments-vitest-test");
const people: Record<string, { id: string; token: string }> = {};
let png: Buffer, jpeg: Buffer, pdf: Buffer;
const context = (id: string, attachmentId?: string, quoteId?: string) => ({
  params: Promise.resolve({ id, attachmentId, quoteId }),
});
function request(
  method = "GET",
  body?: BodyInit,
  token = people.owner.token,
  headers: Record<string, string> = {},
  search = "",
) {
  return new Request(`${origin}/api/purchase-drafts/files${search}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}
function form(version = 1, bytes = png, name = "报价.png", type = "image/png") {
  const data = new FormData();
  data.set("file", new File([new Uint8Array(bytes)], name, { type }));
  data.set("version", String(version));
  return data;
}
const upload = (
  id: string,
  quoteId: string,
  version = 1,
  bytes = png,
  name = "报价.png",
  type = "image/png",
  token = people.owner.token,
) =>
  uploadHandler(
    request("POST", form(version, bytes, name, type), token),
    context(id, undefined, quoteId),
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
  return createPurchaseDraft(
    people.owner.token,
    purchaseDraftSchema.parse({
      title: "采购附件",
      items: [{ name: "设备", quantity: "2", unitPrice: "100" }],
      quotes: [
        { supplierName: "甲", amount: "200", selected: true },
        { supplierName: "乙", amount: "210" },
      ],
    }),
  );
}
async function uploaded(
  app: Awaited<ReturnType<typeof draft>>,
  version = 1,
  quoteIndex = 0,
) {
  const response = await upload(app.id, app.quotes[quoteIndex].id, version);
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

test("JPEG/PNG/PDF 绑定同单报价，元数据、原字节与安全预览/下载头完整", async () => {
  const app = await draft();
  let version = 1,
    totalBytes = 0;
  for (const [bytes, name, type] of [
    [png, "报价.png", "image/png"],
    [jpeg, "截图.jpg", "image/jpeg"],
    [pdf, "证明.pdf", "application/pdf"],
  ] as const) {
    const response = await upload(
      app.id,
      app.quotes[0].id,
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
      quoteId: app.quotes[0].id,
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
        await getPurchaseAttachmentContent(
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
  const current = await getPurchaseDraft(people.owner.token, app.id);
  expect(current.items).toEqual(app.items);
  expect(current.quotes).toEqual(app.quotes);
  expect(current.totalAmount).toBe("200.00");
});
test("跨采购/不存在/其他业务报价拒绝，差旅附件 API 不获得采购权限", async () => {
  const app = await draft(),
    other = await draft();
  const saved = await uploaded(app);
  expect((await upload(app.id, other.quotes[0].id, 2)).status).toBe(404);
  expect((await upload(app.id, randomUUID(), 2)).status).toBe(404);
  expect((await content(other.id, saved.attachment.id)).status).toBe(404);
  expect((await remove(other.id, saved.attachment.id, 1)).status).toBe(404);
  const travel = await createTravelDraft(
    people.owner.token,
    travelDraftSchema.parse({}),
  );
  expect((await upload(travel.id, app.quotes[0].id)).status).toBe(404);
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
      (await uploadHandler(req, context(app.id, undefined, app.quotes[0].id)))
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
    ctx = context(app.id, undefined, app.quotes[0].id);
  for (const key of ["quoteId", "applicantId", "file", "version"]) {
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
      (await upload(app.id, app.quotes[0].id, 1, bytes, name, type)).status,
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
  expect((await getPurchaseDraft(people.owner.token, app.id)).version).toBe(2);
  expect(await files()).toHaveLength(1);
});
test("报价编辑与换序保留附件，省略带附件报价拒绝整单保存，显式删除后才可移除报价", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  const changed = await replacePurchaseDraft(
    people.owner.token,
    app.id,
    replacePurchaseDraftSchema.parse({
      version: 2,
      title: "换序",
      quotes: [app.quotes[1], { ...app.quotes[0], supplierName: "更正名称" }],
    }),
  );
  expect(changed.version).toBe(3);
  expect((await (await list(app.id)).json()).data.items).toEqual([
    saved.attachment,
  ]);
  await expect(
    replacePurchaseDraft(
      people.owner.token,
      app.id,
      replacePurchaseDraftSchema.parse({ version: 3, title: "不应保存" }),
    ),
  ).rejects.toMatchObject({ code: "QUOTE_HAS_ATTACHMENTS", status: 409 });
  expect(await getPurchaseDraft(people.owner.token, app.id)).toEqual(changed);
  expect((await remove(app.id, saved.attachment.id, 3)).status).toBe(200);
  const cleared = await replacePurchaseDraft(
    people.owner.token,
    app.id,
    replacePurchaseDraftSchema.parse({ version: 4 }),
  );
  expect(cleared.quotes).toEqual([]);
  expect(await files()).toEqual([]);
});
test("并发上传使用同一申请版本，整单九件配额跨报价累计", async () => {
  const app = await draft();
  const race = await Promise.all(
    app.quotes.map((quote) => upload(app.id, quote.id)),
  );
  expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
  for (let version = 2; version <= 9; version++)
    await uploaded(app, version, version % 2);
  const result = await upload(app.id, app.quotes[1].id, 10);
  expect(result.status).toBe(413);
  expect((await (await list(app.id)).json()).data.items).toHaveLength(9);
  expect(await files()).toHaveLength(9);
});
test("整单 50 MiB 配额来自数据库，不按单个报价分开计算", async () => {
  const app = await draft();
  // Metadata-only quota fixture; content integrity is exercised separately with real bytes.
  for (let i = 0; i < 5; i++)
    await database().query(
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,supplier_quote_id) VALUES ($1,$2,$3,'quote.png','image/png',10485760,$4,$5)",
      [
        app.id,
        people.owner.id,
        randomUUID(),
        "0".repeat(64),
        app.quotes[i % 2].id,
      ],
    );
  expect((await upload(app.id, app.quotes[1].id)).status).toBe(413);
  expect((await (await list(app.id)).json()).data.totalBytes).toBe(
    50 * 1024 * 1024,
  );
  expect(await files()).toEqual([]);
});
test("上传与删除报价/整张草稿竞争只能一次改变版本，不遗留多余文件", async () => {
  for (const action of ["quote", "draft"]) {
    const app = await draft();
    const mutation =
      action === "quote"
        ? replacePurchaseDraft(
            people.owner.token,
            app.id,
            replacePurchaseDraftSchema.parse({ version: 1, quotes: [] }),
          )
        : deletePurchaseDraft(people.owner.token, app.id, 1);
    const [file, result] = await Promise.all([
      upload(app.id, app.quotes[0].id),
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
    "ALTER TABLE applications ADD CONSTRAINT test_purchase_file_version CHECK(version<3) NOT VALID",
  );
  try {
    expect((await upload(app.id, app.quotes[1].id, 2)).status).toBe(500);
  } finally {
    await database().query(
      "ALTER TABLE applications DROP CONSTRAINT test_purchase_file_version",
    );
  }
  expect((await getPurchaseDraft(people.owner.token, app.id)).version).toBe(2);
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
    "ALTER TABLE applications ADD CONSTRAINT test_purchase_file_delete CHECK(version<3) NOT VALID",
  );
  try {
    expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(500);
    expect(await readFile(path)).toEqual(png);
  } finally {
    await database().query(
      "ALTER TABLE applications DROP CONSTRAINT test_purchase_file_delete",
    );
  }
  expect((await remove(app.id, saved.attachment.id, 1)).status).toBe(409);
  expect((await remove(app.id, saved.attachment.id, 2)).status).toBe(200);
  expect(await files()).toEqual([]);
  expect((await (await list(app.id)).json()).data.version).toBe(3);
});
test("整张草稿删除失败保留报价与文件，成功按引用顺序清理并回收", async () => {
  const app = await draft(),
    saved = await uploaded(app);
  await database().query(
    "CREATE TABLE test_purchase_file_reference(app_id UUID REFERENCES applications(id))",
  );
  await database().query(
    "INSERT INTO test_purchase_file_reference VALUES ($1)",
    [app.id],
  );
  try {
    await expect(
      deletePurchaseDraft(people.owner.token, app.id, 2),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await (await list(app.id)).json()).data.items).toHaveLength(1);
    expect(await readFile(await pathFor(saved.attachment.id))).toEqual(png);
  } finally {
    await database().query("DROP TABLE test_purchase_file_reference");
  }
  await deletePurchaseDraft(people.owner.token, app.id, 2);
  expect(await files()).toEqual([]);
  for (const table of ["attachments", "supplier_quotes", "purchase_requests"])
    expect(
      (await database().query(`SELECT count(*)::int AS n FROM ${table}`))
        .rows[0].n,
    ).toBe(0);
});
test("数据库阻止跨报价/申请关联、无报价上传、元数据改写和非草稿删除", async () => {
  const app = await draft(),
    other = await draft(),
    saved = await uploaded(app);
  const insert = (quoteId: string | null, owner = people.owner.id) =>
    database().query(
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,supplier_quote_id) VALUES ($1,$2,$3,'quote.png','image/png',1,$4,$5)",
      [app.id, owner, randomUUID(), "0".repeat(64), quoteId],
    );
  await expect(insert(other.quotes[0].id)).rejects.toMatchObject({
    code: "23503",
  });
  await expect(insert(null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(app.quotes[0].id, people.head.id)).rejects.toMatchObject({
    code: "23514",
  });
  await expect(
    database().query(
      "UPDATE attachments SET supplier_quote_id=$2 WHERE id=$1",
      [saved.attachment.id, app.quotes[1].id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database().query("DELETE FROM supplier_quotes WHERE id=$1", [
      app.quotes[0].id,
    ]),
  ).rejects.toMatchObject({ code: "23503" });
  await database().query(
    "UPDATE applications SET status='pending',submitted_at=now() WHERE id=$1",
    [app.id],
  );
  expect((await list(app.id)).status).toBe(409);
  expect((await content(app.id, saved.attachment.id)).status).toBe(409);
  expect((await upload(app.id, app.quotes[0].id, 2)).status).toBe(409);
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
      "INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,supplier_quote_id) VALUES ($1,$2,$3,'new.png','image/png',$4,$5,$6)",
      [
        app.id,
        people.owner.id,
        inFlight,
        png.length,
        saved.attachment.sha256,
        app.quotes[1].id,
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
test("重复迁移/连接重建保留报价关联、版本、元数据和原字节", async () => {
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
