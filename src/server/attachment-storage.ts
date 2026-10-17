import { constants } from "node:fs";
import { mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, sep } from "node:path";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { maxAttachmentBytes } from "../lib/attachments";
import { transaction } from "./db";
import { ApiError } from "./errors";

const keyPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function attachmentRoot() {
  // Runtime uploads belong to a private volume, never to the deployment bundle.
  const configured = resolve(
    /* turbopackIgnore: true */
    process.env.ATTACHMENT_STORAGE_DIR || "uploads/attachments",
  );
  const publicPaths = [resolve("public")];
  try {
    publicPaths.push(
      await realpath(/* turbopackIgnore: true */ publicPaths[0]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Reject both lexical and symlink-resolved paths inside the public tree.
  const insidePublic = (path: string) =>
    publicPaths.some((base) => {
      const rel = relative(base, path);
      return (
        rel === "" ||
        (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      );
    });
  if (insidePublic(configured))
    throw Error("Attachment storage must be outside public");
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const root = await realpath(/* turbopackIgnore: true */ configured);
  if (insidePublic(root))
    throw Error("Attachment storage must be outside public");
  return root;
}
async function objectPath(key: string) {
  if (!keyPattern.test(key)) throw Error("Invalid internal storage key");
  return join(await attachmentRoot(), `${key}.blob`);
}
export async function lockAttachmentStorage(client: PoolClient) {
  // Lock order for mutations: organization -> storage -> application.
  await client.query("SELECT pg_advisory_xact_lock_shared(72004)");
}
export async function writeAttachmentObject(key: string, bytes: Buffer) {
  const path = await objectPath(key);
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(await attachmentRoot(), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function readAttachmentObject(record: {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}) {
  try {
    const file = await open(
      await objectPath(record.storageKey),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size !== record.sizeBytes ||
        stat.size > maxAttachmentBytes
      )
        throw Error("File size mismatch");
      const bytes = await file.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
        throw Error("File digest mismatch");
      return bytes;
    } finally {
      await file.close();
    }
  } catch {
    throw new ApiError(
      409,
      "ATTACHMENT_UNAVAILABLE",
      "附件缺失或完整性校验失败，请恢复原文件后重试",
    );
  }
}
export async function verifyTravelAttachments(
  client: PoolClient,
  appId: string,
) {
  const records = await client.query<{
    storageKey: string;
    sizeBytes: number;
    sha256: string;
  }>(
    'SELECT storage_key AS "storageKey",size_bytes AS "sizeBytes",sha256 FROM attachments WHERE app_id=$1',
    [appId],
  );
  for (const record of records.rows) await readAttachmentObject(record);
}
export async function collectAttachmentGarbage() {
  return transaction(async (client) => {
    // An exclusive lock waits for uploads/deletions and any uncertain COMMIT outcome.
    await client.query("SELECT pg_advisory_xact_lock(72004)");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='0'");
    const root = await attachmentRoot();
    const live = new Set(
      (
        await client.query<{ storageKey: string }>(
          'SELECT storage_key::text AS "storageKey" FROM attachments',
        )
      ).rows.map((r) => r.storageKey),
    );
    let removed = 0;
    for (const item of await readdir(root, { withFileTypes: true })) {
      const key = item.name.endsWith(".blob") ? item.name.slice(0, -5) : "";
      if (!item.isFile() || !keyPattern.test(key) || live.has(key)) continue;
      await unlink(join(root, item.name));
      removed++;
    }
    return { removed, retained: live.size };
  });
}
export async function tryCollectAttachmentGarbage() {
  try {
    await collectAttachmentGarbage();
  } catch {
    console.error(
      "Attachment cleanup deferred; run attachments:gc after storage is available",
    );
  }
}
