import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  PurchaseDraft,
  PurchaseDraftInput,
  PurchaseDraftSummary,
  ReplacePurchaseDraftInput,
  purchaseDraftListSchema,
} from "../lib/purchase";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";
import {
  lockAttachmentStorage,
  tryCollectAttachmentGarbage,
} from "./attachment-storage";

const totalSql = `(SELECT CASE WHEN count(*)>0 AND count(amount)=count(*) THEN sum(amount)::numeric(14,2)::text ELSE NULL END FROM purchase_items WHERE app_id=a.id)`;
const summaryColumns = `a.id,a.app_no AS "appNo",a.title,a.type,a.status,a.version,
 a.created_at AS "createdAt",a.updated_at AS "updatedAt",p.budget_limit::text AS "budgetLimit",
 p.single_source AS "singleSource",${totalSql} AS "totalAmount"`;
export async function lockPurchaseDraft(
  client: PoolClient,
  id: string,
  ownerId: string,
  write: boolean,
) {
  const row = (
    await client.query<{ version: number; status: string }>(
      `SELECT version,status FROM applications WHERE id=$1 AND applicant_id=$2 AND type='purchase' FOR ${write ? "UPDATE" : "SHARE"}`,
      [id, ownerId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "采购草稿不存在");
  if (row.status !== "draft")
    throw new ApiError(409, "NOT_DRAFT", "申请已不是草稿，请重新查看申请状态");
  return row;
}
function checkVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "草稿已被修改，请重新加载后再操作",
    );
}
async function detail(client: PoolClient, id: string): Promise<PurchaseDraft> {
  // Caller holds the application lock for the entire multi-table read.
  const row = (
    await client.query<
      Omit<PurchaseDraft, "items" | "quotes" | "createdAt" | "updatedAt"> & {
        createdAt: Date;
        updatedAt: Date;
      }
    >(
      `SELECT ${summaryColumns},a.applicant_id AS "applicantId",a.department_id AS "departmentId",a.submitted_at AS "submittedAt",
     p.reason,p.expected_date::text AS "expectedDate",p.project,p.selection_reason AS "selectionReason",
     p.single_source_reason AS "singleSourceReason",p.remarks
     FROM applications a JOIN purchase_requests p ON p.app_id=a.id WHERE a.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, "DRAFT_INCOMPLETE", "采购草稿明细不完整");
  const items = (
    await client.query<PurchaseDraft["items"][number]>(
      `SELECT id,name,specification,quantity::text,unit,unit_price::text AS "unitPrice",amount::text FROM purchase_items WHERE app_id=$1 ORDER BY position`,
      [id],
    )
  ).rows;
  const quotes = (
    await client.query<PurchaseDraft["quotes"][number]>(
      `SELECT id,supplier_name AS "supplierName",quote_date::text AS "quoteDate",amount::text,basis,
      purchase_url AS "purchaseUrl",is_online AS "isOnline",selected FROM supplier_quotes WHERE app_id=$1 ORDER BY position`,
      [id],
    )
  ).rows;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items,
    quotes,
  };
}
const requestValues = (input: PurchaseDraftInput) => [
  input.reason,
  input.expectedDate,
  input.project,
  input.budgetLimit,
  input.selectionReason,
  input.singleSource,
  input.singleSourceReason,
  input.remarks,
];
async function replaceRows(
  client: PoolClient,
  id: string,
  input: PurchaseDraftInput,
  current?: PurchaseDraft,
) {
  for (const key of ["items", "quotes"] as const) {
    const allowed = new Set(current?.[key].map((row) => row.id));
    if (input[key].some((row) => row.id && !allowed.has(row.id)))
      throw new ApiError(
        400,
        "INVALID_ROW_ID",
        "明细 ID 必须来自本草稿；新明细请省略 ID",
      );
  }
  const removedWithFiles = await client.query(
    "SELECT 1 FROM attachments WHERE app_id=$1 AND supplier_quote_id IS NOT NULL AND NOT (supplier_quote_id=ANY($2::uuid[])) LIMIT 1",
    [id, input.quotes.flatMap((row) => (row.id ? [row.id] : []))],
  );
  if (removedWithFiles.rowCount)
    throw new ApiError(
      409,
      "QUOTE_HAS_ATTACHMENTS",
      "要删除的报价仍有关联附件，请先显式删除附件再保存",
    );
  // Clear selection first, so selecting an existing different quote cannot hit the unique index.
  await client.query(
    "UPDATE supplier_quotes SET selected=false WHERE app_id=$1 AND selected",
    [id],
  );
  await client.query(
    "DELETE FROM purchase_items WHERE app_id=$1 AND NOT (id=ANY($2::uuid[]))",
    [id, input.items.flatMap((row) => (row.id ? [row.id] : []))],
  );
  await client.query(
    "DELETE FROM supplier_quotes WHERE app_id=$1 AND NOT (id=ANY($2::uuid[]))",
    [id, input.quotes.flatMap((row) => (row.id ? [row.id] : []))],
  );
  for (const [index, row] of input.items.entries()) {
    const values = [
      id,
      index + 1,
      row.name,
      row.specification,
      row.quantity,
      row.unit,
      row.unitPrice,
    ];
    if (row.id)
      await client.query(
        `UPDATE purchase_items SET position=$2,name=$3,specification=$4,quantity=$5,unit=$6,unit_price=$7 WHERE app_id=$1 AND id=$8`,
        [...values, row.id],
      );
    else
      await client.query(
        `INSERT INTO purchase_items(app_id,position,name,specification,quantity,unit,unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values,
      );
  }
  for (const [index, row] of input.quotes.entries()) {
    const values = [
      id,
      index + 1,
      row.supplierName,
      row.quoteDate,
      row.amount,
      row.basis,
      row.purchaseUrl,
      row.isOnline,
      row.selected,
    ];
    if (row.id)
      await client.query(
        `UPDATE supplier_quotes SET position=$2,supplier_name=$3,quote_date=$4,amount=$5,basis=$6,purchase_url=$7,is_online=$8,selected=$9 WHERE app_id=$1 AND id=$10`,
        [...values, row.id],
      );
    else
      await client.query(
        `INSERT INTO supplier_quotes(app_id,position,supplier_name,quote_date,amount,basis,purchase_url,is_online,selected) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
  }
}
export async function createPurchaseDraft(
  token: string | undefined,
  input: PurchaseDraftInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const id = (
      await client.query<{ id: string }>(
        "INSERT INTO applications(type,title,applicant_id,department_id) VALUES ('purchase',$1,$2,$3) RETURNING id",
        [input.title, actor.id, actor.departmentId],
      )
    ).rows[0].id;
    await client.query(
      `INSERT INTO purchase_requests(app_id,reason,expected_date,project,budget_limit,selection_reason,single_source,single_source_reason,remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ...requestValues(input)],
    );
    await replaceRows(client, id, input);
    return detail(client, id);
  });
}
export async function getPurchaseDraft(token: string | undefined, id: string) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await lockPurchaseDraft(client, id, actor.id, false);
    return detail(client, id);
  });
}
export async function listPurchaseDrafts(
  token: string | undefined,
  input: z.infer<typeof purchaseDraftListSchema>,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const { page, pageSize, keyword } = input;
    const result = await client.query<{
      total: number;
      items: PurchaseDraftSummary[];
    }>(
      `WITH matching AS (SELECT ${summaryColumns} FROM applications a JOIN purchase_requests p ON p.app_id=a.id
       WHERE a.applicant_id=$1 AND a.type='purchase' AND a.status='draft'
         AND ($2='' OR strpos(lower(a.title),lower($2))>0 OR strpos(lower(a.app_no),lower($2))>0)),
       paged AS (SELECT * FROM matching ORDER BY "updatedAt" DESC,id LIMIT $3 OFFSET $4)
       SELECT (SELECT count(*)::int FROM matching) AS total,
         COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY "updatedAt" DESC,id) FROM paged),'[]'::jsonb) AS items`,
      [actor.id, keyword, pageSize, (page - 1) * pageSize],
    );
    return { ...result.rows[0], page, pageSize };
  });
}
export async function replacePurchaseDraft(
  token: string | undefined,
  id: string,
  input: ReplacePurchaseDraftInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const draft = await lockPurchaseDraft(client, id, actor.id, true);
    checkVersion(draft.version, input.version);
    if (draft.version === 2147483647)
      throw new ApiError(409, "VERSION_LIMIT", "草稿已达到可编辑版本上限");
    const current = await detail(client, id);
    await replaceRows(client, id, input, current);
    await client.query(
      `UPDATE purchase_requests SET reason=$2,expected_date=$3,project=$4,budget_limit=$5,selection_reason=$6,single_source=$7,single_source_reason=$8,remarks=$9 WHERE app_id=$1`,
      [id, ...requestValues(input)],
    );
    await client.query(
      "UPDATE applications SET title=$2,department_id=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id, input.title, actor.departmentId],
    );
    return detail(client, id);
  });
}
export async function deletePurchaseDraft(
  token: string | undefined,
  id: string,
  version: number,
) {
  const result = await transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await lockAttachmentStorage(client);
    const draft = await lockPurchaseDraft(client, id, actor.id, true);
    checkVersion(draft.version, version);
    await client.query("DELETE FROM attachments WHERE app_id=$1", [id]);
    await client.query("DELETE FROM supplier_quotes WHERE app_id=$1", [id]);
    await client.query("DELETE FROM purchase_items WHERE app_id=$1", [id]);
    await client.query("DELETE FROM purchase_requests WHERE app_id=$1", [id]);
    await client.query("DELETE FROM applications WHERE id=$1", [id]);
    return { id, deleted: true };
  });
  await tryCollectAttachmentGarbage();
  return result;
}
