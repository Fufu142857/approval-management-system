import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  maxAttachments,
  maxApplicationAttachmentBytes,
} from "../lib/attachments";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";
import type { PurchaseAttachment } from "../lib/purchase-attachments";
import { lockPurchaseDraft } from "./purchase";
import { lockSubmittedPurchase } from "./purchase-access";
import {
  lockAttachmentStorage,
  readAttachmentObject,
  writeAttachmentObject,
  tryCollectAttachmentGarbage,
} from "./attachment-storage";
import { validateAttachment } from "./attachment-validation";

const columns = `id,app_id AS "appId",uploader_id AS "uploaderId",original_name AS "originalName",
 mime_type AS "mimeType",size_bytes AS "sizeBytes",sha256,created_at AS "createdAt",supplier_quote_id AS "quoteId"`;
type AttachmentRow = Omit<PurchaseAttachment, "createdAt"> & {
  createdAt: Date;
};
const serialize = (row: AttachmentRow): PurchaseAttachment => ({
  id: row.id,
  appId: row.appId,
  quoteId: row.quoteId,
  uploaderId: row.uploaderId,
  originalName: row.originalName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  createdAt: row.createdAt.toISOString(),
});
function editableVersion(current: number, version: number) {
  if (current !== version)
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "申请已变化，请重新加载后操作附件",
    );
  if (current === 2147483647)
    throw new ApiError(409, "VERSION_LIMIT", "申请已达到版本上限");
}
async function requireQuote(client: PoolClient, id: string, quoteId: string) {
  const result = await client.query(
    "SELECT id FROM supplier_quotes WHERE id=$1 AND app_id=$2",
    [quoteId, id],
  );
  if (!result.rowCount)
    throw new ApiError(404, "NOT_FOUND", "报价不存在或不属于此采购草稿");
}
// Check before reading a potentially large body, then recheck inside the mutation transaction.
export async function authorizePurchaseAttachmentUpload(
  token: string | undefined,
  id: string,
  quoteId: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await lockPurchaseDraft(client, id, actor.id, false);
    await requireQuote(client, id, quoteId);
  });
}
export async function uploadPurchaseAttachment(
  token: string | undefined,
  id: string,
  quoteId: string,
  version: number,
  bytes: Buffer,
  filename: string,
  declaredType: string,
) {
  const file = await validateAttachment(bytes, filename, declaredType);
  const storageKey = randomUUID();
  let wroteObject = false;
  try {
    return await transaction(async (client) => {
      const actor = await requireBusinessActor(token, client);
      await lockAttachmentStorage(client);
      const draft = await lockPurchaseDraft(client, id, actor.id, true);
      editableVersion(draft.version, version);
      await requireQuote(client, id, quoteId);
      const usage = (
        await client.query<{ count: number; bytes: number }>(
          "SELECT count(*)::int AS count,COALESCE(sum(size_bytes),0)::int AS bytes FROM attachments WHERE app_id=$1",
          [id],
        )
      ).rows[0];
      if (
        usage.count >= maxAttachments ||
        usage.bytes + file.sizeBytes > maxApplicationAttachmentBytes
      )
        throw new ApiError(
          413,
          "ATTACHMENT_QUOTA_EXCEEDED",
          "每申请最多 9 件附件，累计不超过 50 MiB",
        );
      wroteObject = true;
      await writeAttachmentObject(storageKey, file.bytes);
      const row = (
        await client.query<AttachmentRow>(
          `INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256,supplier_quote_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
          [
            id,
            actor.id,
            storageKey,
            file.originalName,
            file.mimeType,
            file.sizeBytes,
            file.sha256,
            quoteId,
          ],
        )
      ).rows[0];
      await client.query(
        "UPDATE applications SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      return { attachment: serialize(row), version: version + 1 };
    });
  } catch (error) {
    // Never unlink blindly after COMMIT errors: the row may already be committed.
    // GC waits on the storage lock and checks durable references before removing anything.
    if (wroteObject) await tryCollectAttachmentGarbage();
    throw error;
  }
}
async function listAttachments(
  token: string | undefined,
  id: string,
  submitted: boolean,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const app = await (submitted
      ? lockSubmittedPurchase(client, id, actor.id)
      : lockPurchaseDraft(client, id, actor.id, false));
    const result = await client.query<AttachmentRow>(
      `SELECT ${columns} FROM attachments WHERE app_id=$1 ORDER BY created_at,id`,
      [id],
    );
    return {
      items: result.rows.map(serialize),
      totalBytes: result.rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      ...app,
    };
  });
}
export async function deletePurchaseAttachment(
  token: string | undefined,
  id: string,
  attachmentId: string,
  version: number,
) {
  const result = await transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await lockAttachmentStorage(client);
    const draft = await lockPurchaseDraft(client, id, actor.id, true);
    editableVersion(draft.version, version);
    const removed = await client.query(
      "DELETE FROM attachments WHERE id=$1 AND app_id=$2",
      [attachmentId, id],
    );
    if (!removed.rowCount)
      throw new ApiError(404, "NOT_FOUND", "附件不存在或无权操作");
    await client.query(
      "UPDATE applications SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    return { id: attachmentId, deleted: true, version: version + 1 };
  });
  await tryCollectAttachmentGarbage();
  return result;
}
async function attachmentContent(
  token: string | undefined,
  id: string,
  attachmentId: string,
  submitted: boolean,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await (submitted
      ? lockSubmittedPurchase(client, id, actor.id)
      : lockPurchaseDraft(client, id, actor.id, false));
    const result = await client.query<AttachmentRow & { storageKey: string }>(
      `SELECT ${columns},storage_key AS "storageKey" FROM attachments WHERE id=$1 AND app_id=$2`,
      [attachmentId, id],
    );
    if (!result.rowCount)
      throw new ApiError(404, "NOT_FOUND", "附件不存在或无权访问");
    return {
      attachment: serialize(result.rows[0]),
      bytes: await readAttachmentObject(result.rows[0]),
    };
  });
}

export const listPurchaseAttachments = (
  token: string | undefined,
  id: string,
) => listAttachments(token, id, false);
export const listSubmittedPurchaseAttachments = (
  token: string | undefined,
  id: string,
) => listAttachments(token, id, true);
export const getPurchaseAttachmentContent = (
  token: string | undefined,
  id: string,
  attachmentId: string,
) => attachmentContent(token, id, attachmentId, false);
export const getSubmittedPurchaseAttachmentContent = (
  token: string | undefined,
  id: string,
  attachmentId: string,
) => attachmentContent(token, id, attachmentId, true);
