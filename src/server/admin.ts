import type { z } from "zod";
import {
  accessSchema,
  type UserIdentity,
  userListSchema,
  pageSchema,
} from "../lib/identity";
import { readUser, requireAdmin, userColumns } from "./auth";
import { database, transaction } from "./db";
import { ApiError } from "./errors";

export async function changeUserAccess(
  token: string | undefined,
  id: string,
  input: z.infer<typeof accessSchema>,
) {
  return transaction(async (client) => {
    // All authorization changes use the same lock, including organization bootstrap.
    await client.query("SELECT pg_advisory_xact_lock(72002)");
    const actor = await requireAdmin(token, client);
    if (actor.id === id)
      throw new ApiError(
        409,
        "SELF_ACCESS_CHANGE",
        "不能修改自己的部门、状态或角色",
      );
    const target = await client.query(
      "SELECT id FROM users WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!target.rowCount) throw new ApiError(404, "NOT_FOUND", "用户不存在");
    const department = await client.query(
      "SELECT id FROM departments WHERE id=$1 AND active FOR SHARE",
      [input.departmentId],
    );
    if (!department.rowCount)
      throw new ApiError(400, "INVALID_DEPARTMENT", "确认部门不可用");
    const before = await readUser(id, client);
    await client.query(
      "UPDATE users SET department_id=$2,registration_status=$3,updated_at=now() WHERE id=$1",
      [id, input.departmentId, input.status],
    );
    await client.query("DELETE FROM user_roles WHERE user_id=$1", [id]);
    await client.query(
      "INSERT INTO user_roles(user_id,role_code) SELECT $1,unnest($2::text[])",
      [id, input.roles],
    );
    await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    const after = await readUser(id, client);
    await client.query(
      `INSERT INTO admin_audit_logs(actor_id,operation,target_id,before_data,after_data,reason)
       VALUES ($1,'user.access_changed',$2,$3,$4,$5)`,
      [actor.id, id, before, after, input.reason],
    );
    return after;
  });
}

export async function listUsers(
  token: string | undefined,
  input: z.infer<typeof userListSchema>,
) {
  await requireAdmin(token);
  const { page, pageSize, status } = input;
  const values = [status ?? null, pageSize, (page - 1) * pageSize];
  const items = await database().query<UserIdentity>(
    `SELECT ${userColumns} FROM users u WHERE ($1::text IS NULL OR u.registration_status=$1)
     ORDER BY u.created_at DESC,u.id LIMIT $2 OFFSET $3`,
    values,
  );
  const count = await database().query<{ total: number }>(
    "SELECT count(*)::int AS total FROM users WHERE ($1::text IS NULL OR registration_status=$1)",
    [status ?? null],
  );
  return { items: items.rows, total: count.rows[0].total, page, pageSize };
}

export async function listAuditLogs(
  token: string | undefined,
  input: z.infer<typeof pageSchema>,
) {
  await requireAdmin(token);
  const { page, pageSize } = input;
  const items = await database().query(
    `SELECT id, actor_id AS "actorId", operation, target_id AS "targetId",
       before_data AS before, after_data AS after, reason, created_at AS "createdAt"
     FROM admin_audit_logs ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize],
  );
  const count = await database().query<{ total: number }>(
    "SELECT count(*)::int AS total FROM admin_audit_logs",
  );
  return { items: items.rows, total: count.rows[0].total, page, pageSize };
}
