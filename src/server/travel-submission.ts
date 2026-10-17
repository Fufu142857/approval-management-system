import type { PoolClient } from "pg";
import { completeTravelSchema, type TravelApplication } from "../lib/travel";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { verifyTravelAttachments } from "./attachment-storage";
import { ApiError } from "./errors";
import { ownedTravelDraft, travelColumns } from "./travel";

const ruleVersion = "fixed-travel-v1";
type Person = {
  id: string;
  name: string;
  departmentId: string;
  departmentName: string;
};

// These two queries implement one fixed business policy, not configurable role rules.
async function fixedApprovers(
  client: PoolClient,
  departmentId: string,
  applicantId: string,
) {
  const head = await client.query<Person>(
    `SELECT u.id,u.full_name AS name,u.department_id AS "departmentId",d.name AS "departmentName"
     FROM users u JOIN user_roles r ON r.user_id=u.id JOIN departments d ON d.id=u.department_id
     WHERE r.role_code='department_head' AND u.department_id=$1 AND u.registration_status='active' AND d.active
     ORDER BY u.id LIMIT 2`,
    [departmentId],
  );
  const finance = await client.query<Person>(
    `SELECT u.id,u.full_name AS name,u.department_id AS "departmentId",d.name AS "departmentName"
     FROM users u JOIN user_roles r ON r.user_id=u.id JOIN departments d ON d.id=u.department_id
     WHERE r.role_code='finance_approver' AND u.registration_status='active' AND d.active
     ORDER BY u.id LIMIT 2`,
  );
  for (const [label, people] of [
    ["本部门负责人", head.rows],
    ["财务审批人", finance.rows],
  ] as const) {
    if (people.length !== 1)
      throw new ApiError(
        409,
        "APPROVER_UNRESOLVED",
        `${label}必须恰有一名有效人员，请联系管理员核验授权`,
      );
    if (people[0].id === applicantId)
      throw new ApiError(
        409,
        "SELF_APPROVAL",
        "审批路径包含申请人本人，请联系管理员调整授权",
      );
  }
  return [
    {
      seqNo: 1,
      name: "部门审批",
      rule: "applicant_department_head",
      approver: head.rows[0],
    },
    {
      seqNo: 2,
      name: "财务审批",
      rule: "company_finance_approver",
      approver: finance.rows[0],
    },
  ];
}

export async function submittedDetail(
  client: PoolClient,
  id: string,
  actorId: string,
) {
  // Lock first, then authorize in a fresh statement after any waiting writer commits.
  // All state writers hold this same application lock until their transaction completes.
  await client.query(
    "SELECT id FROM applications WHERE id=$1 AND type='travel' FOR SHARE",
    [id],
  );
  // Only activated assignees retain history access; future cancelled tasks grant none.
  const result = await client.query<
    Omit<TravelApplication, "createdAt" | "updatedAt" | "submittedAt"> & {
      createdAt: Date;
      updatedAt: Date;
      submittedAt: Date;
    }
  >(
    `SELECT ${travelColumns} FROM applications a JOIN travel_requests t ON t.app_id=a.id
     WHERE a.id=$1 AND a.type='travel' AND a.status<>'draft'
       AND (a.applicant_id=$2 OR EXISTS (
         SELECT 1 FROM approval_instances i JOIN approval_tasks task ON task.instance_id=i.id
         WHERE i.app_id=a.id AND task.approver_id=$2 AND task.activated_at IS NOT NULL))`,
    [id, actorId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "NOT_FOUND", "申请不存在或无权访问");
  const workflow = (
    await client.query(
      `SELECT id,"rule_version" AS "ruleVersion",submitted_version AS "submittedVersion",
       route_snapshot AS "routeSnapshot",created_at AS "createdAt"
     FROM approval_instances WHERE app_id=$1`,
      [id],
    )
  ).rows[0];
  if (!workflow) throw new ApiError(404, "NOT_FOUND", "审批实例不存在");
  const tasks = (
    await client.query(
      `SELECT id,seq_no AS "seqNo",step_name AS name,approver_id AS "approverId",status,created_at AS "createdAt",
       activated_at AS "activatedAt",finished_at AS "finishedAt"
     FROM approval_tasks WHERE instance_id=$1 ORDER BY seq_no`,
      [workflow.id],
    )
  ).rows;
  const logs = (
    await client.query(
      `SELECT id,task_id AS "taskId",actor_id AS "actorId",action,opinion,result,
       application_version AS "applicationVersion",created_at AS "createdAt"
     FROM approval_logs WHERE instance_id=$1 ORDER BY created_at,id`,
      [workflow.id],
    )
  ).rows;
  const row = result.rows[0];
  const application: TravelApplication = {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt.toISOString(),
  };
  return { application, workflow, tasks, logs };
}

export async function submitTravelDraft(
  token: string | undefined,
  id: string,
  version: number,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const draft = await ownedTravelDraft(client, id, actor.id, true);
    if (draft.version !== version)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "草稿已被修改，请重新加载后再提交",
      );
    if (version === 2147483647)
      throw new ApiError(409, "VERSION_LIMIT", "草稿已达到版本上限");
    // Read saved data under the application lock, never submit a client-provided replacement.
    const complete = completeTravelSchema.parse({
      title: draft.title,
      departure: draft.departure,
      destination: draft.destination,
      startDate: draft.startDate,
      endDate: draft.endDate,
      purpose: draft.purpose,
      companions: draft.companions,
      transportation: draft.transportation,
      budget: draft.budget,
      remarks: draft.remarks,
    });
    await verifyTravelAttachments(client, id);
    const steps = await fixedApprovers(client, actor.departmentId, actor.id);
    const department = (
      await client.query("SELECT name FROM departments WHERE id=$1", [
        actor.departmentId,
      ])
    ).rows[0];
    const snapshot = {
      ruleVersion,
      policy:
        "本部门唯一有效负责人 → 全组织唯一有效财务审批人；不允许本人审批；不按金额分支",
      applicant: {
        id: actor.id,
        name: actor.fullName,
        departmentId: actor.departmentId,
        departmentName: department.name,
      },
      budget: complete.budget,
      durationDays: draft.durationDays,
      steps,
    };
    await client.query(
      `UPDATE applications SET status='pending',department_id=$2,version=version+1,
        submitted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [id, actor.departmentId],
    );
    const instance = (
      await client.query<{ id: string }>(
        `INSERT INTO approval_instances(app_id,rule_version,submitted_version,route_snapshot)
       VALUES ($1,$2,$3,$4) RETURNING id`,
        [id, ruleVersion, version + 1, snapshot],
      )
    ).rows[0];
    let firstTaskId = "";
    for (const step of steps) {
      const task = (
        await client.query<{ id: string }>(
          `INSERT INTO approval_tasks(instance_id,seq_no,step_name,approver_id,status,activated_at)
         VALUES ($1,$2,$3,$4,$5::varchar,CASE WHEN $5::varchar='pending' THEN clock_timestamp() ELSE NULL END) RETURNING id`,
          [
            instance.id,
            step.seqNo,
            step.name,
            step.approver.id,
            step.seqNo === 1 ? "pending" : "blocked",
          ],
        )
      ).rows[0];
      if (step.seqNo === 1) firstTaskId = task.id;
    }
    await client.query(
      `INSERT INTO approval_logs(instance_id,actor_id,action,result,application_version)
       VALUES ($1,$2,'submitted','pending',$3)`,
      [instance.id, actor.id, version + 1],
    );
    await client.query(
      `INSERT INTO notifications(recipient_id,app_id,event_key,kind,title)
       VALUES ($1,$2,$3,'approval.pending',$4)`,
      [
        steps[0].approver.id,
        id,
        `task:${firstTaskId}:pending`,
        `待审批：${complete.title}`,
      ],
    );
    return submittedDetail(client, id, actor.id);
  });
}

export async function getTravelApplication(
  token: string | undefined,
  id: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    return submittedDetail(client, id, actor.id);
  });
}
