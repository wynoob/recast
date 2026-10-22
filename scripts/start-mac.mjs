import { spawn, spawnSync } from "node:child_process";
const build = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit", env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, ["dist/apps/server/main.js"], {
  stdio: "inherit",
  env: process.env,
});
setTimeout(() => {
  spawn("open", ["http://127.0.0.1:4318"], { stdio: "ignore", detached: true }).unref();
}, 900);

const stop = () => {
  server.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => process.exit(code ?? 0));
