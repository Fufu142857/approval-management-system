import type { PoolClient } from "pg";
import { requireUser, tokenHash } from "./auth";
import { ApiError } from "./errors";

export async function requireBusinessActor(
  token: string | undefined,
  client: PoolClient,
) {
  // Shared with other business requests, exclusive against audited organization changes.
  // Take this before session/application locks to preserve admin.ts lock ordering.
  await client.query("SELECT pg_advisory_xact_lock_shared(72002)");
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  const session = await client.query(
    "SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>clock_timestamp() FOR SHARE",
    [tokenHash(token)],
  );
  if (!session.rowCount)
    throw new ApiError(401, "UNAUTHENTICATED", "会话已失效，请重新登录");
  const user = await requireUser(token, client);
  if (user.status !== "active" || !user.departmentId)
    throw new ApiError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      "账号经管理员确认后才能使用业务功能",
    );
  const department = await client.query(
    "SELECT id FROM departments WHERE id=$1 AND active FOR SHARE",
    [user.departmentId],
  );
  if (!department.rowCount)
    throw new ApiError(403, "DEPARTMENT_INACTIVE", "当前所属部门不可用");
  return { ...user, departmentId: user.departmentId };
}
