import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { registerSchema, type UserIdentity } from "../lib/identity";
import { database, transaction } from "./db";
import { ApiError } from "./errors";
import { hashPassword, verifyPassword } from "./password";

export const sessionSeconds = 8 * 60 * 60;
export const userColumns = `u.id, u.username, u.full_name AS "fullName", u.email,
  u.requested_department_id AS "requestedDepartmentId",
  u.department_id AS "departmentId", u.registration_status AS status,
  ARRAY(SELECT role_code FROM user_roles WHERE user_id=u.id ORDER BY role_code) AS roles`;
type Connection = PoolClient | ReturnType<typeof database>;

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function readUser(
  id: string,
  connection: Connection = database(),
) {
  const result = await connection.query<UserIdentity>(
    `SELECT ${userColumns} FROM users u WHERE u.id=$1`,
    [id],
  );
  if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "用户不存在");
  return result.rows[0];
}

export async function register(input: z.infer<typeof registerSchema>) {
  const passwordHash = await hashPassword(input.password);
  return transaction(async (client) => {
    const department = await client.query(
      "SELECT id FROM departments WHERE id=$1 AND active FOR SHARE",
      [input.requestedDepartmentId],
    );
    if (!department.rowCount)
      throw new ApiError(400, "INVALID_DEPARTMENT", "申请部门不可用");
    const result = await client.query<{ id: string }>(
      `INSERT INTO users(username, full_name, email, password_hash, requested_department_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        input.username,
        input.fullName,
        input.email,
        passwordHash,
        input.requestedDepartmentId,
      ],
    );
    const id = result.rows[0].id;
    await client.query(
      "INSERT INTO user_roles(user_id,role_code) VALUES ($1,'employee')",
      [id],
    );
    return readUser(id, client);
  });
}

async function reserveLoginAttempt(username: string) {
  const result = await database().query<{ attempts: number }>(
    `INSERT INTO auth_rate_limits(bucket, attempts) VALUES ($1,1)
     ON CONFLICT (bucket) DO UPDATE SET
       attempts=CASE WHEN auth_rate_limits.window_start <= now()-interval '15 minutes'
         THEN 1 ELSE LEAST(auth_rate_limits.attempts+1,11) END,
       window_start=CASE WHEN auth_rate_limits.window_start <= now()-interval '15 minutes'
         THEN now() ELSE auth_rate_limits.window_start END
     RETURNING attempts`,
    [tokenHash(`login:${username}`)],
  );
  if (result.rows[0].attempts > 10) {
    throw new ApiError(429, "RATE_LIMITED", "尝试次数过多，请在 15 分钟后重试");
  }
}

// Equal-cost password work for nonexistent accounts; this hash is never a login credential.
const dummyHash = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;

export async function login(username: string, password: string) {
  await reserveLoginAttempt(username);
  return transaction(async (client) => {
    // Serialize issuance with access changes, so disabling cannot leave a new usable session.
    const result = await client.query<{
      id: string;
      password_hash: string;
      registration_status: string;
    }>(
      "SELECT id,password_hash,registration_status FROM users WHERE username=$1 FOR UPDATE",
      [username],
    );
    const account = result.rows[0];
    const valid = await verifyPassword(
      password,
      account?.password_hash ?? dummyHash,
    );
    if (!valid || !account || account.registration_status === "disabled") {
      throw new ApiError(
        401,
        "INVALID_CREDENTIALS",
        "用户名或密码错误，或账户不可用",
      );
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + sessionSeconds * 1000);
    await client.query(
      "DELETE FROM sessions WHERE user_id=$1 AND expires_at<=now()",
      [account.id],
    );
    await client.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
      [tokenHash(token), account.id, expiresAt],
    );
    return { token, expiresAt, user: await readUser(account.id, client) };
  });
}

export async function requireUser(
  token: string | undefined,
  connection: Connection = database(),
) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  }
  const result = await connection.query<UserIdentity>(
    `SELECT ${userColumns} FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND u.registration_status<>'disabled'`,
    [tokenHash(token)],
  );
  if (!result.rows[0])
    throw new ApiError(401, "UNAUTHENTICATED", "会话已失效，请重新登录");
  return result.rows[0];
}

export async function requireAdmin(
  token: string | undefined,
  connection: Connection = database(),
) {
  const user = await requireUser(token, connection);
  if (user.status !== "active" || !user.roles.includes("system_admin")) {
    throw new ApiError(403, "FORBIDDEN", "需要已确认的系统管理员权限");
  }
  return user;
}

export async function logout(token: string | undefined) {
  if (token)
    await database().query("DELETE FROM sessions WHERE token_hash=$1", [
      tokenHash(token),
    ]);
}
