import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { transaction } from "./db";

export async function migrate() {
  // TODO(S5-人工): 在 db/migrations 新增后续编号迁移，自行完成模板/字段/节点/版本及自定义申请存储和既有表兼容；不要改写001–017，也不要在这里直接建业务表。
  const directory = path.join(process.cwd(), "db/migrations");
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(72001)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const name of files) {
      const sql = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
    }
  });
}
