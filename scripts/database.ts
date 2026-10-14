import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { closeDatabase } from "../src/server/db";
import { migrate } from "../src/server/migrate";
import { seedOrganization } from "../src/server/seed";

if (existsSync(".env")) loadEnvFile(".env");

try {
  const command = process.argv[2];
  if (command === "migrate") {
    await migrate();
    console.log("Database migrations are up to date.");
  } else if (command === "seed") {
    await seedOrganization(process.env.ADMIN_INITIAL_PASSWORD ?? "");
    console.log(
      "Organization initialized. Existing passwords and permissions were preserved.",
    );
  } else {
    throw new Error("Usage: tsx scripts/database.ts migrate|seed");
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Database command failed",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
