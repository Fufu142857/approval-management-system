import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) loadEnvFile(".env");
process.env.ATTACHMENT_STORAGE_DIR = resolve("tmp/attachments-vitest-test");

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
