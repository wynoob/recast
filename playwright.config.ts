import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: process.env.DCW_E2E_OUTPUT ?? "test-results",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    baseURL: process.env.DCW_E2E_BASE_URL ?? "http://127.0.0.1:4318",
    trace: "retain-on-failure",
  },
});
