import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { collectAttachmentGarbage } from "../src/server/attachment-storage";
import { closeDatabase } from "../src/server/db";
if (existsSync(".env")) loadEnvFile(".env");
try {
  console.log(await collectAttachmentGarbage());
} catch {
  console.error(
    "Attachment cleanup failed; verify database and storage availability",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
