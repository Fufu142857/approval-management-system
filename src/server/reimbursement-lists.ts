import type {
  ReimbursementApplicationListInput,
  ReimbursementTaskListInput,
  ReimbursementApplicationSummary,
  ReimbursementTaskSummary,
} from "../lib/reimbursement-lists";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";

// Fixed reimbursement summaries only. Submitted names come from the immutable snapshot;
// draft names reflect the stored applicant/department. Never expose future tasks.
const summary = `jsonb_build_object(
  'id',a.id,'appNo',a.app_no,'type',a.type,'title',a.title,'status',a.status,'version',a.version,
  'noReceiptCount',(SELECT count(*)::int FROM reimbursement_items WHERE app_id=a.id AND no_receipt),
  'totalAmount',(SELECT CASE WHEN count(*)>0 AND count(amount)=count(*) THEN sum(amount)::numeric(14,2)::text ELSE NULL END FROM reimbursement_items WHERE app_id=a.id),
  'createdAt',a.created_at,'updatedAt',a.updated_at,'submittedAt',a.submitted_at,
  'applicant',jsonb_build_object('id',a.applicant_id,'departmentId',a.department_id,
    'name',CASE WHEN a.status='draft' THEN u.full_name ELSE i.route_snapshot->'applicant'->>'name' END,
    'departmentName',CASE WHEN a.status='draft' THEN d.name ELSE i.route_snapshot->'applicant'->>'departmentName' END),
  'currentTask',CASE WHEN current_task.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id',current_task.id,'seqNo',current_task.seq_no,'name',current_task.step_name,
    'approver',jsonb_build_object('id',current_task.approver_id,
      'name',i.route_snapshot->'steps'->(current_task.seq_no-1)->'approver'->>'name')) END)`;
const summaryJoins = `JOIN reimbursement_requests p ON p.app_id=a.id
  JOIN users u ON u.id=a.applicant_id
  JOIN departments d ON d.id=a.department_id
  LEFT JOIN LATERAL (SELECT t.* FROM approval_tasks t
    WHERE t.instance_id=i.id AND t.status='pending' AND t.activated_at IS NOT NULL
      AND a.status='pending') current_task ON true`;
const filters = `a.type='reimbursement' AND ($2='all' OR a.status=$2)
  AND ($3='' OR strpos(lower(a.title),lower($3))>0 OR strpos(lower(a.app_no),lower($3))>0)`;
// Inclusive Shanghai calendar days, expressed as a half-open timestamp interval.
function timeFilter(column: string) {
  return `($4::date IS NULL OR ${column} >= ($4::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
    AND ($5::date IS NULL OR ${column} < (($5::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'))`;
}
function parameters(actorId: string, input: ReimbursementApplicationListInput) {
  return [
    actorId,
    input.status,
    input.keyword,
    input.from ?? null,
    input.to ?? null,
    input.pageSize,
    (input.page - 1) * input.pageSize,
  ];
}
// Rows, total, current task and application version all share ONE SQL snapshot.
// A returned task is a query-time observation, not a reservation for later approval.
export async function listReimbursementApplications(
  token: string | undefined,
  input: ReimbursementApplicationListInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const result = await client.query<{
      items: ReimbursementApplicationSummary[];
      total: number;
    }>(
      `WITH matching AS (
        SELECT a.id,a.created_at,${summary} AS item FROM applications a
        LEFT JOIN approval_instances i ON i.app_id=a.id ${summaryJoins}
        WHERE a.applicant_id=$1 AND ${filters} AND ${timeFilter("a.created_at")}
      ), paged AS (SELECT * FROM matching ORDER BY created_at DESC,id LIMIT $6 OFFSET $7)
      SELECT (SELECT count(*)::int FROM matching) AS total,
        COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC,id) FROM paged),'[]'::jsonb) AS items`,
      parameters(actor.id, input),
    );
    return { ...result.rows[0], page: input.page, pageSize: input.pageSize };
  });
}
export async function listReimbursementTasks(
  token: string | undefined,
  input: ReimbursementTaskListInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    // State selects server-owned SQL fragments, never interpolated user text.
    const pending = input.state === "pending";
    const time = pending ? "t.activated_at" : "t.finished_at";
    const scope = pending
      ? "t.status='pending' AND a.status='pending' AND NOT EXISTS (SELECT 1 FROM approval_tasks previous WHERE previous.instance_id=i.id AND previous.seq_no<t.seq_no AND previous.status<>'approved')"
      : "t.status IN ('approved','rejected')";
    const result = await client.query<{
      items: ReimbursementTaskSummary[];
      total: number;
    }>(
      `WITH matching AS (
        SELECT t.id,${time} AS event_at,jsonb_build_object(
          'id',t.id,'seqNo',t.seq_no,'name',t.step_name,'status',t.status,
          'activatedAt',t.activated_at,'finishedAt',t.finished_at,'application',${summary}) AS item
        FROM approval_tasks t JOIN approval_instances i ON i.id=t.instance_id
        JOIN applications a ON a.id=i.app_id ${summaryJoins}
        WHERE t.approver_id=$1 AND a.applicant_id<>$1 AND a.status<>'draft'
          AND t.activated_at IS NOT NULL AND ${scope} AND ${filters} AND ${timeFilter(time)}
      ), paged AS (SELECT * FROM matching ORDER BY event_at DESC,id LIMIT $6 OFFSET $7)
      SELECT (SELECT count(*)::int FROM matching) AS total,
        COALESCE((SELECT jsonb_agg(item ORDER BY event_at DESC,id) FROM paged),'[]'::jsonb) AS items`,
      parameters(actor.id, input),
    );
    return {
      ...result.rows[0],
      page: input.page,
      pageSize: input.pageSize,
      state: input.state,
    };
  });
}
