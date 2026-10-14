import { transaction } from "./db";
import { hashPassword } from "./password";

export async function seedOrganization(adminPassword: string) {
  if (adminPassword.length < 12 || adminPassword.length > 128) {
    throw new Error("ADMIN_INITIAL_PASSWORD must contain 12–128 characters");
  }
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(72002)");
    for (const name of ["研发部", "市场部", "财务部"]) {
      await client.query(
        "INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [name],
      );
    }
    // Repeat initialization must never reset a password or silently elevate an existing account.
    const initialized = await client.query(
      "SELECT 1 FROM admin_audit_logs WHERE operation = 'organization.bootstrap'",
    );
    if (initialized.rowCount) return;
    const collision = await client.query(
      "SELECT 1 FROM users WHERE username = 'admin' OR lower(email) = 'admin@example.invalid'",
    );
    if (collision.rowCount)
      throw new Error(
        "Reserved bootstrap account exists; initialization stopped",
      );
    const department = await client.query(
      "SELECT id FROM departments WHERE name = '研发部'",
    );
    const admin = await client.query(
      `INSERT INTO users
      (username, full_name, email, password_hash, department_id, requested_department_id, registration_status)
      VALUES ('admin', '系统管理员', 'admin@example.invalid', $1, $2, $2, 'active') RETURNING id`,
      [await hashPassword(adminPassword), department.rows[0].id],
    );
    await client.query(
      "INSERT INTO user_roles (user_id, role_code) VALUES ($1, 'system_admin'), ($1, 'employee')",
      [admin.rows[0].id],
    );
    await client.query(
      `INSERT INTO admin_audit_logs (actor_id, operation, target_id, after_data, reason)
      VALUES ($1, 'organization.bootstrap', $1, $2, '首次初始化组织与管理员')`,
      [
        admin.rows[0].id,
        JSON.stringify({
          username: "admin",
          roles: ["system_admin", "employee"],
        }),
      ],
    );
  });
}
