import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-b", "--pretty", "false"],
  { stdio: "inherit", env: process.env },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const web = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "apps/web/tsconfig.json", "--pretty", "false"],
  { stdio: "inherit", env: process.env },
);
process.exit(web.status ?? 1);
