import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  ReimbursementDraft,
  ReimbursementDraftInput,
  ReplaceReimbursementDraftInput,
  ReimbursementDraftSummary,
  ReimbursementLinkedApplication,
  ReimbursementLinkSummary,
  reimbursementDraftListSchema,
  reimbursementLinkOptionsSchema,
} from "../lib/reimbursement";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";

const totalSql = `(SELECT CASE WHEN count(*)>0 AND count(amount)=count(*) THEN sum(amount)::numeric(14,2)::text ELSE NULL END FROM reimbursement_items WHERE app_id=a.id)`;
const summaryColumns = `a.id,a.app_no AS "appNo",a.title,a.type,a.status,a.version,
 a.created_at AS "createdAt",a.updated_at AS "updatedAt",${totalSql} AS "totalAmount",
 (SELECT count(*)::int FROM reimbursement_items WHERE app_id=a.id AND no_receipt) AS "noReceiptCount"`;
const linkColumns = `a.id,a.app_no AS "appNo",a.title,a.type,a.status,a.submitted_at AS "submittedAt",a.department_id AS "departmentId"`;
export async function lockReimbursementDraft(
  client: PoolClient,
  id: string,
  ownerId: string,
  write: boolean,
) {
  const row = (
    await client.query<{ version: number; status: string }>(
      `SELECT version,status FROM applications WHERE id=$1 AND applicant_id=$2 AND type='reimbursement' FOR ${write ? "UPDATE" : "SHARE"}`,
      [id, ownerId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "报销草稿不存在");
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
// Only the owner may select links. Lock sources in UUID order after the target lock.
async function lockSources(client: PoolClient, ids: string[], ownerId: string) {
  if (!ids.length) return;
  const result = await client.query(
    `SELECT id FROM applications WHERE id=ANY($1::uuid[]) AND applicant_id=$2
     AND type IN ('travel','purchase') AND status='approved' ORDER BY id FOR SHARE`,
    [ids, ownerId],
  );
  if (result.rowCount !== ids.length)
    throw new ApiError(
      404,
      "LINK_NOT_AVAILABLE",
      "关联申请不存在或不是本人已批准的采购/差旅申请",
    );
}
async function detail(
  client: PoolClient,
  id: string,
  ownerId: string,
): Promise<ReimbursementDraft> {
  // Caller holds the target lock across header, items and source information reads.
  const row = (
    await client.query<
      Omit<
        ReimbursementDraft,
        | "items"
        | "linkedApplications"
        | "linkedApplicationIds"
        | "createdAt"
        | "updatedAt"
      > & { createdAt: Date; updatedAt: Date }
    >(
      `SELECT ${summaryColumns},a.applicant_id AS "applicantId",a.department_id AS "departmentId",a.submitted_at AS "submittedAt",
      r.description,r.independent_reason AS "independentReason",r.remarks
     FROM applications a JOIN reimbursement_requests r ON r.app_id=a.id WHERE a.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, "DRAFT_INCOMPLETE", "报销草稿明细不完整");
  const ids = (
    await client.query<{ id: string }>(
      "SELECT source_app_id AS id FROM application_links WHERE target_app_id=$1 ORDER BY source_app_id",
      [id],
    )
  ).rows.map((row) => row.id);
  await lockSources(client, ids, ownerId);
  const linked = (
    await client.query<
      Omit<ReimbursementLinkedApplication, "submittedAt"> & {
        submittedAt: Date;
      }
    >(
      `SELECT ${linkColumns},
      CASE WHEN a.type='travel' THEN jsonb_build_object('departure',t.departure,'destination',t.destination,'startDate',t.start_date::text,'endDate',t.end_date::text,'durationDays',t.duration_days,'budget',t.budget::text) END AS travel,
      CASE WHEN a.type='purchase' THEN jsonb_build_object('budgetLimit',p.budget_limit::text,'totalAmount',(SELECT sum(amount)::numeric(14,2)::text FROM purchase_items WHERE app_id=a.id)) END AS purchase
     FROM applications a LEFT JOIN travel_requests t ON t.app_id=a.id LEFT JOIN purchase_requests p ON p.app_id=a.id
     WHERE a.id=ANY($1::uuid[]) AND a.applicant_id=$2 AND a.status='approved' AND a.type IN ('travel','purchase') ORDER BY a.id`,
      [ids, ownerId],
    )
  ).rows;
  const items = (
    await client.query<ReimbursementDraft["items"][number]>(
      `SELECT id,category,expense_date::text AS "expenseDate",purpose,amount::text,no_receipt AS "noReceipt",no_receipt_reason AS "noReceiptReason"
     FROM reimbursement_items WHERE app_id=$1 ORDER BY position`,
      [id],
    )
  ).rows;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    linkedApplicationIds: ids,
    linkedApplications: linked.map((row) => ({
      ...row,
      submittedAt: row.submittedAt.toISOString(),
    })),
    items,
  };
}
async function replaceRows(
  client: PoolClient,
  id: string,
  input: ReimbursementDraftInput,
  currentIds: string[] = [],
) {
  const allowed = new Set(currentIds);
  if (input.items.some((row) => row.id && !allowed.has(row.id)))
    throw new ApiError(
      400,
      "INVALID_ROW_ID",
      "费用明细 ID 必须来自本草稿；新明细请省略 ID",
    );
  await client.query(
    "DELETE FROM reimbursement_items WHERE app_id=$1 AND NOT (id=ANY($2::uuid[]))",
    [id, input.items.flatMap((row) => (row.id ? [row.id] : []))],
  );
  for (const [index, row] of input.items.entries()) {
    const values = [
      id,
      index + 1,
      row.category,
      row.expenseDate,
      row.purpose,
      row.amount,
      row.noReceipt,
      row.noReceiptReason,
    ];
    if (row.id)
      await client.query(
        `UPDATE reimbursement_items SET position=$2,category=$3,expense_date=$4,purpose=$5,amount=$6,no_receipt=$7,no_receipt_reason=$8 WHERE app_id=$1 AND id=$9`,
        [...values, row.id],
      );
    else
      await client.query(
        `INSERT INTO reimbursement_items(app_id,position,category,expense_date,purpose,amount,no_receipt,no_receipt_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        values,
      );
  }
  await client.query(
    "DELETE FROM application_links WHERE target_app_id=$1 AND NOT (source_app_id=ANY($2::uuid[]))",
    [id, input.linkedApplicationIds],
  );
  for (const source of [...input.linkedApplicationIds].sort())
    await client.query(
      "INSERT INTO application_links(source_app_id,target_app_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [source, id],
    );
}
export async function createReimbursementDraft(
  token: string | undefined,
  input: ReimbursementDraftInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const id = (
      await client.query<{ id: string }>(
        "INSERT INTO applications(type,title,applicant_id,department_id) VALUES ('reimbursement',$1,$2,$3) RETURNING id",
        [input.title, actor.id, actor.departmentId],
      )
    ).rows[0].id;
    await lockSources(client, input.linkedApplicationIds, actor.id);
    await client.query(
      "INSERT INTO reimbursement_requests(app_id,description,independent_reason,remarks) VALUES ($1,$2,$3,$4)",
      [id, input.description, input.independentReason, input.remarks],
    );
    await replaceRows(client, id, input);
    return detail(client, id, actor.id);
  });
}
export async function getReimbursementDraft(
  token: string | undefined,
  id: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await lockReimbursementDraft(client, id, actor.id, false);
    return detail(client, id, actor.id);
  });
}
export async function listReimbursementDrafts(
  token: string | undefined,
  input: z.infer<typeof reimbursementDraftListSchema>,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const { page, pageSize, keyword } = input;
    const result = await client.query<{
      total: number;
      items: ReimbursementDraftSummary[];
    }>(
      `WITH matching AS (SELECT ${summaryColumns} FROM applications a JOIN reimbursement_requests r ON r.app_id=a.id
       WHERE a.applicant_id=$1 AND a.type='reimbursement' AND a.status='draft'
         AND ($2='' OR strpos(lower(a.title),lower($2))>0 OR strpos(lower(a.app_no),lower($2))>0)),
       paged AS (SELECT * FROM matching ORDER BY "updatedAt" DESC,id LIMIT $3 OFFSET $4)
       SELECT (SELECT count(*)::int FROM matching) AS total,
         COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY "updatedAt" DESC,id) FROM paged),'[]'::jsonb) AS items`,
      [actor.id, keyword, pageSize, (page - 1) * pageSize],
    );
    return { ...result.rows[0], page, pageSize };
  });
}
export async function listReimbursementLinkOptions(
  token: string | undefined,
  input: z.infer<typeof reimbursementLinkOptionsSchema>,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const { page, pageSize, keyword, type } = input;
    const result = await client.query<{
      total: number;
      items: ReimbursementLinkSummary[];
    }>(
      `WITH matching AS (SELECT ${linkColumns} FROM applications a
       WHERE a.applicant_id=$1 AND a.status='approved' AND a.type IN ('travel','purchase') AND ($2::text IS NULL OR a.type=$2)
         AND ($3='' OR strpos(lower(a.title),lower($3))>0 OR strpos(lower(a.app_no),lower($3))>0)),
       paged AS (SELECT * FROM matching ORDER BY "submittedAt" DESC,id LIMIT $4 OFFSET $5)
       SELECT (SELECT count(*)::int FROM matching) AS total,
         COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY "submittedAt" DESC,id) FROM paged),'[]'::jsonb) AS items`,
      [actor.id, type ?? null, keyword, pageSize, (page - 1) * pageSize],
    );
    return { ...result.rows[0], page, pageSize };
  });
}
export async function replaceReimbursementDraft(
  token: string | undefined,
  id: string,
  input: ReplaceReimbursementDraftInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const current = await lockReimbursementDraft(client, id, actor.id, true);
    checkVersion(current.version, input.version);
    if (current.version === 2147483647)
      throw new ApiError(409, "VERSION_LIMIT", "草稿已达到可编辑版本上限");
    await lockSources(client, input.linkedApplicationIds, actor.id);
    const ids = (
      await client.query<{ id: string }>(
        "SELECT id FROM reimbursement_items WHERE app_id=$1",
        [id],
      )
    ).rows.map((row) => row.id);
    await replaceRows(client, id, input, ids);
    await client.query(
      "UPDATE reimbursement_requests SET description=$2,independent_reason=$3,remarks=$4 WHERE app_id=$1",
      [id, input.description, input.independentReason, input.remarks],
    );
    await client.query(
      "UPDATE applications SET title=$2,department_id=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id, input.title, actor.departmentId],
    );
    return detail(client, id, actor.id);
  });
}
export async function deleteReimbursementDraft(
  token: string | undefined,
  id: string,
  version: number,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const current = await lockReimbursementDraft(client, id, actor.id, true);
    checkVersion(current.version, version);
    await client.query("DELETE FROM application_links WHERE target_app_id=$1", [
      id,
    ]);
    await client.query("DELETE FROM reimbursement_items WHERE app_id=$1", [id]);
    await client.query("DELETE FROM reimbursement_requests WHERE app_id=$1", [
      id,
    ]);
    await client.query("DELETE FROM applications WHERE id=$1", [id]);
    return { id, deleted: true };
  });
}
