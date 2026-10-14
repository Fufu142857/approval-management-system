import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "@playwright/test";
if (existsSync(".env")) loadEnvFile(".env");
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error(
    "E2E tests require a dedicated TEST_DATABASE_URL ending in _test",
  );
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  outputDir: "tmp/playwright-results",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1365, height: 900 },
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec next start --hostname 127.0.0.1 --port 3101",
    url: "http://127.0.0.1:3101/login",
    reuseExistingServer: false,
    timeout: 30000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 2000 },
    env: {
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: "http://127.0.0.1:3101",
      SESSION_COOKIE_SECURE: "false",
    },
  },
});
