import { spawnSync } from "node:child_process";

const build = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-b", "--pretty", "false"],
  { stdio: "inherit", env: process.env },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const test = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run"],
  { stdio: "inherit", env: process.env },
);
process.exit(test.status ?? 1);
