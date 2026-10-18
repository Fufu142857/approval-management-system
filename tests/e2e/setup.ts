import { closeDatabase, database } from "../../src/server/db";
import { migrate } from "../../src/server/migrate";
import { seedOrganization } from "../../src/server/seed";
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Dedicated _test database required");
  process.env.DATABASE_URL = url;
  try {
    await migrate();
    await database().query(
      "TRUNCATE admin_audit_logs,sessions,user_roles,users,departments,auth_rate_limits CASCADE",
    );
    await seedOrganization("Browser-test-password");
    // Deterministic pagination fixtures, never used by development or production.
    await database()
      .query(`INSERT INTO users(username,full_name,email,password_hash,requested_department_id,department_id,registration_status)
      SELECT 'roster_'||lpad(i::text,2,'0'), '测试成员 '||i, 'roster_'||i||'@example.invalid',
        u.password_hash,u.department_id,u.department_id,'active'
      FROM users u CROSS JOIN generate_series(0,21) i WHERE u.username='admin'`);
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) SELECT id,'employee' FROM users WHERE username LIKE 'roster_%'",
    );
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) SELECT id,'department_head' FROM users WHERE username='roster_20'",
    );
    await database().query(
      "INSERT INTO user_roles(user_id,role_code) SELECT id,'finance_approver' FROM users WHERE username='roster_21'",
    );
  } finally {
    await closeDatabase();
  }
}
