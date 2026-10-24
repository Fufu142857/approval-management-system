import type { PoolClient } from "pg";
import { readReimbursementDetail } from "./reimbursement";
import type {
  ReimbursementResubmission,
  ReimbursementResubmissionResult,
  ReimbursementSuccessor,
} from "../lib/reimbursement-resubmission";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";

async function source(
  client: PoolClient,
  id: string,
  ownerId: string,
  write: boolean,
) {
  const result = await client.query<{
    id: string;
    title: string;
    version: number;
    status: string;
  }>(
    `SELECT id,title,version,status FROM applications WHERE id=$1 AND applicant_id=$2 AND type='reimbursement' FOR ${write ? "UPDATE" : "SHARE"}`,
    [id, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "原申请不存在或无权访问");
  if (!["rejected", "withdrawn"].includes(row.status))
    throw new ApiError(
      409,
      "NOT_RESUBMITTABLE",
      "仅本人已驳回或已撤回的报销申请可以复制重提",
    );
  return row;
}
async function successor(client: PoolClient, id: string, ownerId: string) {
  return (
    (
      await client.query<ReimbursementSuccessor>(
        `SELECT id,app_no AS "appNo",status,version FROM applications
      WHERE resubmission_of=$1 AND applicant_id=$2 AND type='reimbursement' FOR SHARE`,
        [id, ownerId],
      )
    ).rows[0] ?? null
  );
}
export async function getReimbursementResubmission(
  token: string | undefined,
  id: string,
): Promise<ReimbursementResubmission> {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await source(client, id, actor.id, false);
    return { sourceId: id, successor: await successor(client, id, actor.id) };
  });
}
export async function copyReimbursementForResubmission(
  token: string | undefined,
  id: string,
  version: number,
): Promise<ReimbursementResubmissionResult> {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    // Serialize copies on the source, without changing its version, timestamps or history.
    const original = await source(client, id, actor.id, true);
    if (original.version !== version)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "原申请版本已变化，请重新读取后操作",
      );
    const existing = await successor(client, id, actor.id);
    if (existing) return { sourceId: id, successor: existing, created: false };
    // Owner-only copying revalidates live approved links, rather than granting
    // source access from the old workflow's frozen summaries. Locks are UUID ordered.
    const saved = await readReimbursementDetail(client, id);
    if (!saved.items.length)
      throw new ApiError(
        409,
        "SOURCE_INCOMPLETE",
        "原申请费用不完整，请核对后再复制",
      );
    const copied = (
      await client.query<ReimbursementSuccessor>(
        `INSERT INTO applications(type,title,applicant_id,department_id,resubmission_of)
        VALUES ('reimbursement',$1,$2,$3,$4) RETURNING id,app_no AS "appNo",status,version`,
        [original.title, actor.id, actor.departmentId, id],
      )
    ).rows[0];
    const detail = await client.query(
      `INSERT INTO reimbursement_requests(app_id,description,independent_reason,remarks)
       SELECT $1,description,independent_reason,remarks FROM reimbursement_requests WHERE app_id=$2`,
      [copied.id, id],
    );
    // Keep NUMERIC amounts and explicit exceptions; new rows receive new IDs.
    const items = await client.query(
      `INSERT INTO reimbursement_items(app_id,position,category,expense_date,purpose,amount,no_receipt,no_receipt_reason)
       SELECT $1,position,category,expense_date,purpose,amount,no_receipt,no_receipt_reason
       FROM reimbursement_items WHERE app_id=$2 ORDER BY position`,
      [copied.id, id],
    );
    await client.query(
      `INSERT INTO application_links(source_app_id,target_app_id)
       SELECT source_app_id,$1 FROM application_links WHERE target_app_id=$2 ORDER BY source_app_id`,
      [copied.id, id],
    );
    if (detail.rowCount !== 1 || items.rowCount !== saved.items.length)
      throw new ApiError(
        409,
        "SOURCE_INCOMPLETE",
        "原申请费用不完整，请核对后再复制",
      );
    // Attachments and execution records stay on the source. New submission revalidates everything.
    return { sourceId: id, successor: copied, created: true };
  });
}
