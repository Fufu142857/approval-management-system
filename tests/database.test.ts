import { afterAll, beforeAll, expect, test } from "vitest";
import { closeDatabase, database } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";
import { hashPassword, verifyPassword } from "../src/server/password";

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) {
    throw new Error(
      "Set TEST_DATABASE_URL to a dedicated database ending in _test",
    );
  }
  process.env.DATABASE_URL = url;
  await migrate();
});
afterAll(closeDatabase);

test("重复迁移和初始化不重设已有管理员密码或部门", async () => {
  await database().query(
    "TRUNCATE admin_audit_logs, sessions, user_roles, users, departments, auth_rate_limits CASCADE",
  );
  await seedOrganization("First-admin-password");
  const before = await database().query(
    "SELECT id, password_hash FROM users WHERE username='admin'",
  );
  await migrate();
  await seedOrganization("A-different-password");
  const after = await database().query(
    "SELECT id, password_hash FROM users WHERE username='admin'",
  );
  expect(after.rows).toEqual(before.rows);
  expect(
    (await database().query("SELECT count(*) FROM departments")).rows[0].count,
  ).toBe("3");
  expect(
    (await database().query("SELECT count(*) FROM admin_audit_logs")).rows[0]
      .count,
  ).toBe("1");
  expect(
    await verifyPassword("First-admin-password", after.rows[0].password_hash),
  ).toBe(true);
  expect(
    await verifyPassword("A-different-password", after.rows[0].password_hash),
  ).toBe(false);
});

test("密码采用独立随机盐和强散列，错误密码与损坏散列不能通过", async () => {
  const first = await hashPassword("Example-password-123");
  const second = await hashPassword("Example-password-123");
  expect(first).not.toEqual(second);
  expect(first).not.toContain("Example-password-123");
  expect(await verifyPassword("Example-password-123", first)).toBe(true);
  expect(await verifyPassword("wrong-password", first)).toBe(false);
  expect(
    await verifyPassword("Example-password-123", "scrypt-v1$invalid$bad"),
  ).toBe(false);
});
