import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const evidenceRoot =
  process.env.DCW_EVIDENCE_ROOT ??
  "/Users/wangyun/Projects/AI-Harness/agent-evidence/dmall-content-workbench/recast-20261021/t01-root";
const dataRoot = join(evidenceRoot, `e2e-data-${Date.now()}`);
const port = process.env.DCW_E2E_PORT ?? "4321";
mkdirSync(dataRoot, { recursive: true });

const build = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit", env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, ["dist/apps/server/main.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    DCW_DATA_ROOT: dataRoot,
    DCW_PORT: port,
    DCW_WEB_ROOT: join(process.cwd(), "dist", "web"),
    DCW_LOG_LEVEL: "warn",
  },
});
server.stdout?.on("data", (data) => process.stdout.write(data));
server.stderr?.on("data", (data) => process.stderr.write(data));

const baseUrl = `http://127.0.0.1:${port}`;
const playwrightEnv = {
  ...process.env,
  DCW_E2E_BASE_URL: baseUrl,
  DCW_E2E_OUTPUT: join(evidenceRoot, "e2e-results"),
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(process.cwd(), ".tools", "ms-playwright"),
};

const wait = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { host: `127.0.0.1:${port}` },
      });
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("E2E server did not become ready");
};

try {
  await wait();
  const result = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.config.ts"],
    { stdio: "inherit", env: playwrightEnv },
  );
  process.exitCode = result.status ?? 1;
} finally {
  server.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await new Promise((resolve) => server.once("exit", resolve));
  }
}
