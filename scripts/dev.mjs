import { spawn, spawnSync } from "node:child_process";

const build = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit", env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, ["dist/apps/server/main.js"], {
  stdio: "inherit",
  env: process.env,
});
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"],
  { stdio: "inherit", env: process.env },
);

const stop = (code = 0) => {
  server.kill("SIGTERM");
  vite.kill("SIGTERM");
  setTimeout(() => process.exit(code), 120);
};
server.on("exit", (code) => stop(code ?? 1));
vite.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
