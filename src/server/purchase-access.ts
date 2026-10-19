import type { PoolClient } from "pg";
import { ApiError } from "./errors";

// Caller must first authenticate an active business actor in this transaction.
export async function lockSubmittedPurchase(
  client: PoolClient,
  id: string,
  actorId: string,
) {
  await client.query(
    "SELECT id FROM applications WHERE id=$1 AND type='purchase' FOR SHARE",
    [id],
  );
  // Recheck authorization after any pending writer has committed.
  const row = (
    await client.query<{ version: number; status: string }>(
      `SELECT a.version,a.status FROM applications a
     WHERE a.id=$1 AND a.type='purchase' AND a.status<>'draft'
       AND (a.applicant_id=$2 OR EXISTS (
         SELECT 1 FROM approval_instances i JOIN approval_tasks t ON t.instance_id=i.id
         WHERE i.app_id=a.id AND t.approver_id=$2 AND t.activated_at IS NOT NULL))`,
      [id, actorId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "申请不存在或无权访问");
  return row;
}
