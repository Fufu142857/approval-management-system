import type { PoolClient } from "pg";
import type {
  PurchaseResubmission,
  PurchaseResubmissionResult,
  PurchaseSuccessor,
} from "../lib/purchase-resubmission";
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
    `SELECT id,title,version,status FROM applications WHERE id=$1 AND applicant_id=$2 AND type='purchase' FOR ${write ? "UPDATE" : "SHARE"}`,
    [id, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "原申请不存在或无权访问");
  if (!["rejected", "withdrawn"].includes(row.status))
    throw new ApiError(
      409,
      "NOT_RESUBMITTABLE",
      "仅本人已驳回或已撤回的采购申请可以复制重提",
    );
  return row;
}
async function successor(client: PoolClient, id: string, ownerId: string) {
  return (
    (
      await client.query<PurchaseSuccessor>(
        `SELECT id,app_no AS "appNo",status,version FROM applications
      WHERE resubmission_of=$1 AND applicant_id=$2 AND type='purchase' FOR SHARE`,
        [id, ownerId],
      )
    ).rows[0] ?? null
  );
}
export async function getPurchaseResubmission(
  token: string | undefined,
  id: string,
): Promise<PurchaseResubmission> {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await source(client, id, actor.id, false);
    return { sourceId: id, successor: await successor(client, id, actor.id) };
  });
}
export async function copyPurchaseForResubmission(
  token: string | undefined,
  id: string,
  version: number,
): Promise<PurchaseResubmissionResult> {
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
    const copied = (
      await client.query<PurchaseSuccessor>(
        `INSERT INTO applications(type,title,applicant_id,department_id,resubmission_of)
        VALUES ('purchase',$1,$2,$3,$4) RETURNING id,app_no AS "appNo",status,version`,
        [original.title, actor.id, actor.departmentId, id],
      )
    ).rows[0];
    const detail = await client.query(
      `INSERT INTO purchase_requests(app_id,reason,expected_date,project,budget_limit,selection_reason,single_source,single_source_reason,remarks)
       SELECT $1,reason,expected_date,project,budget_limit,selection_reason,single_source,single_source_reason,remarks FROM purchase_requests WHERE app_id=$2`,
      [copied.id, id],
    );
    // Generate fresh row IDs; generated amounts are recalculated by PostgreSQL exactly.
    const items = await client.query(
      `INSERT INTO purchase_items(app_id,position,name,specification,quantity,unit,unit_price)
       SELECT $1,position,name,specification,quantity,unit,unit_price FROM purchase_items WHERE app_id=$2 ORDER BY position`,
      [copied.id, id],
    );
    const quotes = await client.query(
      `INSERT INTO supplier_quotes(app_id,position,supplier_name,quote_date,amount,basis,purchase_url,is_online,selected)
       SELECT $1,position,supplier_name,quote_date,amount,basis,purchase_url,is_online,selected FROM supplier_quotes WHERE app_id=$2 ORDER BY position`,
      [copied.id, id],
    );
    if (detail.rowCount !== 1 || !items.rowCount || !quotes.rowCount)
      throw new ApiError(
        409,
        "SOURCE_INCOMPLETE",
        "原申请明细不完整，请核对后再复制",
      );
    // Attachments and execution records stay on the source. New submission revalidates everything.
    return { sourceId: id, successor: copied, created: true };
  });
}
