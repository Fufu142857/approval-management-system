import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  maxAttachments,
  maxApplicationAttachmentBytes,
  type Attachment,
} from "../lib/attachments";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";
import { ownedTravelDraft } from "./travel";
import {
  lockAttachmentStorage,
  readAttachmentObject,
  writeAttachmentObject,
  tryCollectAttachmentGarbage,
} from "./attachment-storage";
import { validateAttachment } from "./attachment-validation";

const columns = `id,app_id AS "appId",uploader_id AS "uploaderId",original_name AS "originalName",
 mime_type AS "mimeType",size_bytes AS "sizeBytes",sha256,created_at AS "createdAt"`;
type AttachmentRow = Omit<Attachment, "createdAt"> & { createdAt: Date };
const serialize = (row: AttachmentRow): Attachment => ({
  ...row,
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
async function readableApplication(
  client: PoolClient,
  id: string,
  actorId: string,
) {
  await client.query(
    "SELECT id FROM applications WHERE id=$1 AND type='travel' FOR SHARE",
    [id],
  );
  const result = await client.query<{ version: number; status: string }>(
    `SELECT a.version,a.status FROM applications a WHERE a.id=$1 AND a.type='travel' AND
     (a.applicant_id=$2 OR (a.status<>'draft' AND EXISTS(SELECT 1 FROM approval_instances i
       JOIN approval_tasks t ON t.instance_id=i.id WHERE i.app_id=a.id AND t.approver_id=$2 AND t.activated_at IS NOT NULL)))`,
    [id, actorId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "NOT_FOUND", "申请不存在或无权访问");
  return result.rows[0];
}
// Check before reading a potentially large body, then recheck inside the mutation transaction.
export async function authorizeAttachmentUpload(
  token: string | undefined,
  id: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await ownedTravelDraft(client, id, actor.id);
  });
}
export async function uploadTravelAttachment(
  token: string | undefined,
  id: string,
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
      const draft = await ownedTravelDraft(client, id, actor.id, true);
      editableVersion(draft.version, version);
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
          `INSERT INTO attachments(app_id,uploader_id,storage_key,original_name,mime_type,size_bytes,sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
          [
            id,
            actor.id,
            storageKey,
            file.originalName,
            file.mimeType,
            file.sizeBytes,
            file.sha256,
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
export async function listTravelAttachments(
  token: string | undefined,
  id: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const app = await readableApplication(client, id, actor.id);
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
export async function deleteTravelAttachment(
  token: string | undefined,
  id: string,
  attachmentId: string,
  version: number,
) {
  const result = await transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await lockAttachmentStorage(client);
    const draft = await ownedTravelDraft(client, id, actor.id, true);
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
export async function getTravelAttachmentContent(
  token: string | undefined,
  id: string,
  attachmentId: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await readableApplication(client, id, actor.id);
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
