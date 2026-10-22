import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = join(root, "evidence", "verify-t05-product");
const logs = join(evidenceRoot, "logs");
mkdirSync(logs, { recursive: true });

const env = {
  ...process.env,
  TMPDIR: process.env.TMPDIR ?? join(root, ".runtime", "tmp"),
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(root, ".runtime", "cache"),
  npm_config_cache: process.env.npm_config_cache ?? join(root, ".runtime", "npm"),
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    "/Users/wangyun/Projects/recast/.tools/ms-playwright",
  DCW_LOG_LEVEL: "error",
  DCW_EVIDENCE_ROOT: join(evidenceRoot, "e2e"),
  DCW_E2E_PORT: process.env.DCW_E2E_PORT ?? "4333",
};

const checks = [
  {
    id: "check",
    command: process.execPath,
    args: ["scripts/check.mjs"],
  },
  {
    id: "test",
    command: process.execPath,
    args: ["node_modules/vitest/vitest.mjs", "run"],
  },
  {
    id: "build",
    command: process.execPath,
    args: ["scripts/build.mjs"],
  },
  {
    id: "template-samples-browser",
    command: process.execPath,
    args: ["packages/templates/scripts/browser-check.mjs"],
  },
  {
    id: "e2e",
    command: process.execPath,
    args: ["scripts/e2e.mjs"],
  },
];

const results = [];
let failed = false;
for (const check of checks) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(check.command, check.args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const durationMs = Math.round(performance.now() - started);
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  writeFileSync(join(logs, `${check.id}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  const record = {
    id: check.id,
    startedAt,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    command: [check.command, ...check.args],
    log: join("logs", `${check.id}.log`),
  };
  results.push(record);
  if (result.status !== 0) {
    failed = true;
    break;
  }
}

writeFileSync(
  join(evidenceRoot, "results.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: !failed,
    results,
  }, null, 2)}\n`,
  "utf8",
);

if (failed) process.exitCode = 1;
