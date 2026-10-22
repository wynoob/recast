import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.versions.node !== "24.22.0") {
  throw new Error(`需要 Node 24.22.0，当前为 ${process.version}`);
}

const pnpm = existsSync(".tools/pnpm/node_modules/.bin/pnpm")
  ? ".tools/pnpm/node_modules/.bin/pnpm"
  : process.env.PNPM_BIN;
if (pnpm === undefined) {
  throw new Error("缺少项目 pnpm，设置 PNPM_BIN 指向 pnpm10.34.7");
}

const result = spawnSync(process.execPath, [pnpm, "install"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `.tools/runtime/bin:.tools/pnpm/node_modules/.bin:${process.env.PATH ?? ""}`,
  },
});
if (result.status !== 0) process.exit(result.status ?? 1);
