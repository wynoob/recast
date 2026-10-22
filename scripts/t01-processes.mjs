import { spawnSync } from "node:child_process";

export function processIdentities() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  return result.stdout.split("\n").flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) return [];
    return [{ pid: Number(parts[0]), parentPid: Number(parts[1]), startedAt: parts.slice(2, 7).join(" "), command: parts.slice(7).join(" ") }];
  });
}

export function workerIdentities(parentPid) {
  return processIdentities().filter((row) => row.parentPid === parentPid && row.command.includes("dist/apps/worker/main.js"));
}

export function identityStillAlive(identity) {
  return processIdentities().some((row) => row.pid === identity.pid && row.startedAt === identity.startedAt && row.command === identity.command);
}
