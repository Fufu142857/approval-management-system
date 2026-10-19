import type { PoolClient } from "pg";
import type {
  PurchaseDecisionInput,
  PurchaseWithdrawalInput,
} from "../lib/purchase-actions";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";
import { submittedPurchaseDetail } from "./purchase-submission";

type Application = {
  id: string;
  applicantId: string;
  title: string;
  status: string;
  version: number;
};
type Task = {
  id: string;
  instanceId: string;
  seqNo: number;
  approverId: string;
  status: string;
  activatedAt: Date | null;
};
async function lockApplication(client: PoolClient, id: string) {
  const result = await client.query<Application>(
    `SELECT id,applicant_id AS "applicantId",title,status,version FROM applications
     WHERE id=$1 AND type='purchase' FOR UPDATE`,
    [id],
  );
  if (!result.rowCount)
    throw new ApiError(404, "NOT_FOUND", "申请不存在或无权访问");
  return result.rows[0];
}
function checkState(app: Application, version: number) {
  if (app.status !== "pending")
    throw new ApiError(409, "STATE_CHANGED", "申请已不在审批中，请刷新详情");
  if (app.version !== version)
    throw new ApiError(409, "VERSION_CONFLICT", "申请状态已变化，请刷新详情");
  if (version === 2147483647)
    throw new ApiError(409, "VERSION_LIMIT", "申请已达到版本上限");
}
async function tasksFor(client: PoolClient, id: string) {
  const result = await client.query<Task>(
    `SELECT t.id,t.instance_id AS "instanceId",t.seq_no AS "seqNo",t.approver_id AS "approverId",
      t.status,t.activated_at AS "activatedAt" FROM approval_tasks t
     JOIN approval_instances i ON i.id=t.instance_id WHERE i.app_id=$1 ORDER BY t.seq_no`,
    [id],
  );
  return result.rows;
}
async function recordTransition(
  client: PoolClient,
  app: Application,
  instanceId: string,
  taskId: string | null,
  actorId: string,
  action: string,
  opinion: string,
  result: string,
) {
  await client.query(
    "UPDATE applications SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
    [app.id, result],
  );
  await client.query(
    `INSERT INTO approval_logs(instance_id,task_id,actor_id,action,opinion,result,application_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [instanceId, taskId, actorId, action, opinion, result, app.version + 1],
  );
}
async function notify(
  client: PoolClient,
  recipientId: string,
  app: Application,
  event: string,
  kind: string,
  label: string,
) {
  await client.query(
    "INSERT INTO notifications(recipient_id,app_id,event_key,kind,title) VALUES ($1,$2,$3,$4,$5)",
    [recipientId, app.id, event, kind, `${label}：${app.title}`],
  );
}

export async function decidePurchaseTask(
  token: string | undefined,
  id: string,
  taskId: string,
  input: PurchaseDecisionInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const app = await lockApplication(client, id);
    if (app.applicantId === actor.id)
      throw new ApiError(403, "SELF_APPROVAL", "不能审批本人申请");
    const tasks = await tasksFor(client, id);
    const task = tasks.find(
      (item) => item.id === taskId && item.approverId === actor.id,
    );
    if (!task) throw new ApiError(404, "NOT_FOUND", "任务不存在或无权操作");
    checkState(app, input.version);
    if (
      task.status !== "pending" ||
      tasks.some(
        (item) => item.seqNo < task.seqNo && item.status !== "approved",
      )
    )
      throw new ApiError(
        409,
        "TASK_NOT_PENDING",
        "任务不是当前有效待办，请刷新详情",
      );
    const next = tasks.find((item) => item.seqNo > task.seqNo);
    if (input.decision === "approve" && next) {
      if (next.status !== "blocked")
        throw new ApiError(409, "STATE_CHANGED", "后续任务状态已变化");
      // Keep the frozen assignee, even after role changes. Never silently reroute or skip.
      const available = await client.query(
        `SELECT u.id FROM users u JOIN departments d ON d.id=u.department_id
         WHERE u.id=$1 AND u.registration_status='active' AND d.active`,
        [next.approverId],
      );
      if (!available.rowCount || next.approverId === app.applicantId)
        throw new ApiError(
          409,
          "APPROVER_UNAVAILABLE",
          "后续快照审批人不可用，请联系管理员核验账号",
        );
    }
    const action = input.decision === "approve" ? "approved" : "rejected";
    // Close the current task before activating the next (one-pending unique index).
    await client.query(
      "UPDATE approval_tasks SET status=$2,finished_at=clock_timestamp() WHERE id=$1",
      [task.id, action],
    );
    let result = action;
    if (input.decision === "approve" && next) {
      result = "pending";
      await client.query(
        "UPDATE approval_tasks SET status='pending',activated_at=clock_timestamp() WHERE id=$1",
        [next.id],
      );
      await notify(
        client,
        next.approverId,
        app,
        `task:${next.id}:pending`,
        "approval.pending",
        "待审批",
      );
    } else {
      if (input.decision === "reject")
        await client.query(
          "UPDATE approval_tasks SET status='cancelled',finished_at=clock_timestamp() WHERE instance_id=$1 AND status IN ('pending','blocked')",
          [task.instanceId],
        );
      await notify(
        client,
        app.applicantId,
        app,
        `application:${app.id}:${app.version + 1}:${action}`,
        `application.${action}`,
        action === "approved" ? "申请已通过" : "申请已驳回",
      );
    }
    await recordTransition(
      client,
      app,
      task.instanceId,
      task.id,
      actor.id,
      action,
      input.opinion,
      result,
    );
    return submittedPurchaseDetail(client, id, actor.id);
  });
}

export async function withdrawPurchaseApplication(
  token: string | undefined,
  id: string,
  input: PurchaseWithdrawalInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const app = await lockApplication(client, id);
    if (app.applicantId !== actor.id)
      throw new ApiError(404, "NOT_FOUND", "申请不存在或无权操作");
    checkState(app, input.version);
    const tasks = await tasksFor(client, id);
    const current = tasks.find((task) => task.status === "pending");
    if (!current)
      throw new ApiError(409, "STATE_CHANGED", "当前待办状态已变化");
    await client.query(
      "UPDATE approval_tasks SET status='cancelled',finished_at=clock_timestamp() WHERE instance_id=$1 AND status IN ('pending','blocked')",
      [current.instanceId],
    );
    await recordTransition(
      client,
      app,
      current.instanceId,
      current.id,
      actor.id,
      "withdrawn",
      input.opinion,
      "withdrawn",
    );
    // Only people who actually received a task may follow the withdrawal notification.
    const recipients = new Set([
      app.applicantId,
      ...tasks
        .filter((task) => task.activatedAt !== null)
        .map((task) => task.approverId),
    ]);
    for (const recipient of recipients)
      await notify(
        client,
        recipient,
        app,
        `application:${app.id}:${app.version + 1}:withdrawn`,
        "application.withdrawn",
        "申请已撤回",
      );
    return submittedPurchaseDetail(client, id, actor.id);
  });
}
