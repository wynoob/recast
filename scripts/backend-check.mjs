import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-b", "--pretty", "false"], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
