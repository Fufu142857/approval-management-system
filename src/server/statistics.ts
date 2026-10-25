import {
  statisticsSchema,
  type StatisticsInput,
  type FixedBusinessStatistics,
} from "../lib/statistics";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";

export async function getFixedBusinessStatistics(
  token: string | undefined,
  input: StatisticsInput,
): Promise<FixedBusinessStatistics> {
  const filters = statisticsSchema.parse(input);
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    let departmentId = filters.departmentId ?? null;
    if (filters.scope === "department") {
      if (
        !actor.roles.includes("department_head") ||
        (departmentId !== null && departmentId !== actor.departmentId)
      )
        throw new ApiError(
          403,
          "STATISTICS_FORBIDDEN",
          "仅部门负责人可查看当前所属部门统计",
        );
      departmentId = actor.departmentId;
    }
    // One statement keeps counts, task state and precise amounts on the same snapshot.
    // The stored application department survives later employee transfers.
    const result = await client.query<
      Pick<FixedBusinessStatistics, "applications" | "pendingTasks">
    >(
      `WITH types AS (
        SELECT type FROM (VALUES ('travel'),('purchase'),('reimbursement')) v(type)
        WHERE $4='all' OR type=$4
      ), filtered AS NOT MATERIALIZED (
        SELECT a.id,a.type,a.status,a.applicant_id FROM applications a
        WHERE a.type IN ('travel','purchase','reimbursement')
          AND a.submitted_at IS NOT NULL AND a.status<>'draft'
          AND ($3::uuid IS NULL OR a.department_id=$3)
          AND ($4='all' OR a.type=$4)
          AND ($5::date IS NULL OR a.submitted_at >= ($5::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
          AND ($6::date IS NULL OR a.submitted_at < (($6::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))
      ), owned AS MATERIALIZED (
        SELECT a.id,a.type,a.status,
          CASE WHEN a.status='approved' THEN CASE a.type
            WHEN 'travel' THEN (SELECT budget FROM travel_requests WHERE app_id=a.id)
            WHEN 'purchase' THEN (SELECT CASE WHEN count(*)>0 AND count(amount)=count(*) THEN sum(amount) END FROM purchase_items WHERE app_id=a.id)
            WHEN 'reimbursement' THEN (SELECT CASE WHEN count(*)>0 AND count(amount)=count(*) THEN sum(amount) END FROM reimbursement_items WHERE app_id=a.id)
          END END AS amount
        FROM filtered a WHERE $2='department' OR a.applicant_id=$1
      ), grouped AS (
        SELECT types.type,count(a.id)::int AS total,
          jsonb_build_object('pending',count(a.id) FILTER (WHERE a.status='pending')::int,
            'approved',count(a.id) FILTER (WHERE a.status='approved')::int,
            'rejected',count(a.id) FILTER (WHERE a.status='rejected')::int,
            'withdrawn',count(a.id) FILTER (WHERE a.status='withdrawn')::int) AS statuses,
          CASE WHEN count(a.id) FILTER (WHERE a.status='approved' AND a.amount IS NULL)>0 THEN NULL
            ELSE round(coalesce(sum(a.amount) FILTER (WHERE a.status='approved'),0),2)::text END AS amount,
          count(a.id) FILTER (WHERE a.status='approved' AND a.amount IS NULL)::int AS missing
        FROM types LEFT JOIN owned a ON a.type=types.type GROUP BY types.type
      ), tasks AS MATERIALIZED (
        SELECT a.type,t.id FROM filtered a
        JOIN approval_instances i ON i.app_id=a.id
        JOIN approval_tasks t ON t.instance_id=i.id
        WHERE t.approver_id=$1 AND a.applicant_id<>$1 AND a.status='pending'
          AND t.status='pending' AND t.activated_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM approval_tasks previous
            WHERE previous.instance_id=i.id AND previous.seq_no<t.seq_no AND previous.status<>'approved')
      )
      SELECT jsonb_build_object('total',(SELECT count(*)::int FROM owned),
        'statuses',(SELECT jsonb_build_object(
          'pending',count(*) FILTER (WHERE status='pending')::int,
          'approved',count(*) FILTER (WHERE status='approved')::int,
          'rejected',count(*) FILTER (WHERE status='rejected')::int,
          'withdrawn',count(*) FILTER (WHERE status='withdrawn')::int) FROM owned),
        'byType',(SELECT jsonb_agg(jsonb_build_object('type',type,'total',total,'statuses',statuses,
          'approvedAmount',amount,'approvedAmountMissingCount',missing) ORDER BY type) FROM grouped)) AS applications,
        jsonb_build_object('total',(SELECT count(*)::int FROM tasks),
          'byType',(SELECT jsonb_agg(jsonb_build_object('type',type,'count',
            (SELECT count(*)::int FROM tasks t WHERE t.type=types.type)) ORDER BY type) FROM types)) AS "pendingTasks"`,
      [
        actor.id,
        filters.scope,
        departmentId,
        filters.type,
        filters.from ?? null,
        filters.to ?? null,
      ],
    );
    return {
      filters: {
        scope: filters.scope,
        departmentId,
        type: filters.type,
        from: filters.from ?? null,
        to: filters.to ?? null,
        timeBasis: "submittedAt",
        timezone: "Asia/Shanghai",
      },
      ...result.rows[0],
    };
  });
}
