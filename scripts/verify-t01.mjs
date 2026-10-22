import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { workerIdentities, identityStillAlive } from "./t01-processes.mjs";

const evidenceRoot =
  process.env.DCW_EVIDENCE_ROOT ??
  "/Users/wangyun/Projects/AI-Harness/agent-evidence/dmall-content-workbench/recast-20261021/t01-root";
const runRoot = join(evidenceRoot, `runtime-${Date.now()}`);
const dataRoot = join(runRoot, "data");
const port = process.env.DCW_VERIFY_PORT ?? "4322";
const base = `http://127.0.0.1:${port}`;
const checks = [];
let server = null;
let auth = null;
const observations = {};
const children = [];

const build = spawnSync(process.execPath, [process.env.DCW_BACKEND_ONLY === "1" ? "scripts/backend-check.mjs" : "scripts/build.mjs"], { stdio: "inherit", env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(dataRoot, { recursive: true });
await mkdir(runRoot, { recursive: true });

try {
  server = await startServer("server-initial.log");
  auth = await session();
  checks.push(await check("health", async () => {
    const body = await json("/api/v1/health");
    return body.data.database.journalMode === "wal" && body.data.workers.ready === 2;
  }));

  const portConflictData = join(runRoot, "port-conflict-data");
  const portConflict = spawn(process.execPath, ["dist/apps/server/main.js"], {
    cwd: process.cwd(),
    env: { ...process.env, DCW_DATA_ROOT: portConflictData, DCW_PORT: port, DCW_LOG_LEVEL: "debug" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForExit(portConflict, 5_000);
  if (portConflict.exitCode === null && portConflict.signalCode === null) await stop(portConflict);
  checks.push({
    name: "port_conflict",
    ok: portConflict.exitCode !== null && portConflict.exitCode !== 0,
  });

  const probe = await createJob("/api/v1/jobs/local-probe", { schemaVersion: 1 });
  const probeDone = await waitForJob(probe.data.id, (job) => job.state === "succeeded");
  await writeFile(join(runRoot, "local-probe.json"), JSON.stringify(probeDone, null, 2));
  checks.push({ name: "local_probe", ok: probeDone.result?.jobType === "local_env_probe" });

  const long = await createJob("/api/v1/jobs/fixture", {
    schemaVersion: 1,
    steps: 20,
    stepMs: 180,
  });
  const running = await waitForJob(long.data.id, (job) =>
    job.state === "running" && job.checkpoint?.jobType === "fixture_long" && job.checkpoint.cursor >= 2,
  );
  const firstEvents = await readSse(long.data.id, 0);
  checks.push({
    name: "sse_persistent",
    ok: firstEvents.some((event) => event.seq === 1) && running.attempt === 1,
  });

  const killedPid = server.pid;
  const knownWorkers = workerIdentities(killedPid);
  if (knownWorkers.length !== 2) throw new Error("cannot observe both worker identities before killing parent");
  server.kill("SIGKILL");
  await waitForExit(server, 3_000);
  await sleep(300);
  const orphan = knownWorkers.filter(identityStillAlive);
  observations.parentCrash = { killedPid, knownWorkers, surviving: orphan };
  checks.push({ name: "worker_exits_with_parent", ok: orphan.length === 0 });
  const checkpointDb = new Database(join(dataRoot, "db/workbench.sqlite"), { readonly: true });
  const durable = checkpointDb.prepare("SELECT checkpoint_json FROM jobs WHERE id=?").get(long.data.id);
  const eventBoundary = checkpointDb.prepare("SELECT MAX(seq) seq FROM job_events WHERE job_id=?").get(long.data.id).seq;
  checkpointDb.close();
  const savedCheckpoint = JSON.parse(durable.checkpoint_json);


  server = await startServer("server-restarted.log");
  auth = await session();
  const recovered = await waitForJob(long.data.id, (job) => job.state === "succeeded", 20_000);
  const replay = await readSse(long.data.id, 0);
  const replayAfter = await readSse(long.data.id, firstEvents.at(-1)?.seq ?? 0);
  const grant = server.verifyLines.flatMap((line) => line.split("\n")).flatMap((line) => {
    try { const parsed = JSON.parse(line); return parsed.msg === "job granted" && parsed.jobId === long.data.id ? [parsed] : []; } catch { return []; }
  })[0];
  const resumedSteps = replay.filter((event) => event.seq > eventBoundary && event.phase === "fixture").map((event) => event.done);
  observations.resume = { savedCheckpoint, eventBoundary, grant, resumedSteps, replay, replayAfter };
  checks.push({
    name: "restart_from_checkpoint",
    ok:
      grant !== undefined &&
      JSON.stringify(grant.checkpoint) === JSON.stringify(savedCheckpoint) &&
      resumedSteps.length === 20 - savedCheckpoint.cursor &&
      resumedSteps.every((step, index) => step === savedCheckpoint.cursor + index + 1) &&
      recovered.attempt >= 2 &&
      recovered.checkpoint?.jobType === "fixture_long" &&
      recovered.checkpoint.cursor === 20 &&
      replay.some((event) => event.seq > firstEvents[0]?.seq) &&
      (replayAfter.length === 0 || (replayAfter[0]?.seq ?? 0) > (firstEvents.at(-1)?.seq ?? 0)),
  });

  const workerKillJob = await createJob("/api/v1/jobs/fixture", {
    schemaVersion: 1,
    steps: 20,
    stepMs: 120,
  });
  await waitForJob(workerKillJob.data.id, (job) => job.state === "running");
  for (const worker of workerIdentities(server.pid)) process.kill(worker.pid, "SIGKILL");
  const workerRecovered = await waitForJob(workerKillJob.data.id, (job) => job.state === "succeeded", 15_000);
  checks.push({
    name: "worker_kill_recovery",
    ok: workerRecovered.attempt >= 2 && workerRecovered.checkpoint?.cursor === 20,
  });

  const cancellable = await createJob("/api/v1/jobs/fixture", {
    schemaVersion: 1,
    steps: 40,
    stepMs: 100,
  });
  await sleep(400);
  const cancelled = await post(`/api/v1/jobs/${cancellable.data.id}/cancel`, {});
  const cancelledDone = await waitForJob(cancellable.data.id, (job) => job.state === "cancelled", 8_000);
  checks.push({
    name: "cancel",
    ok: cancelled.statusCode === 200 && cancelledDone.state === "cancelled",
  });

  const lockRoot = join(runRoot, "concurrent-lock-data");
  const contenders = Array.from({ length: 4 }, (_, index) => {
    const contender = spawn(process.execPath, ["dist/apps/server/main.js"], {
      cwd: process.cwd(),
      env: { ...process.env, DCW_DATA_ROOT: lockRoot, DCW_PORT: String(Number(port) + 10 + index), DCW_LOG_LEVEL: "debug" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = { child: contender, port: Number(port) + 10 + index, log: "" };
    contender.stdout.on("data", (data) => { record.log += data.toString(); });
    contender.stderr.on("data", (data) => { record.log += data.toString(); });
    children.push(contender);
    return record;
  });
  await sleep(2_000);
  const live = contenders.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  observations.lockCompetition = contenders.map(({ child, port, log }) => ({ pid: child.pid, port, exitCode: child.exitCode, signal: child.signalCode, log }));
  const winner = live[0];
  let winnerHealthy = false;
  if (winner !== undefined) winnerHealthy = (await fetch(`http://127.0.0.1:${winner.port}/api/v1/health`)).ok;
  checks.push({ name: "single_instance", ok: live.length === 1 && winnerHealthy && contenders.filter((item) => item !== winner).every(({ child, log }) => child.exitCode !== null && child.exitCode !== 0 && log.includes("工作台已有运行实例") && !log.includes("已被占用")) });
  await writeFile(join(runRoot, "second-instance.log"), JSON.stringify(observations.lockCompetition, null, 2));

} finally {
  if (server !== null) await stop(server);
  for (const child of children) await stop(child);
  await writeFile(join(runRoot, "observations.json"), JSON.stringify(observations, null, 2));
  const result = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    dataRoot,
    checks: checks.map((item) => ({ name: item.name, ok: item.ok })),
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).length,
  };
  await writeFile(join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failed > 0) process.exitCode = 1;
}

async function startServer(logName) {
  const child = spawn(process.execPath, ["dist/apps/server/main.js"], {
    cwd: process.cwd(),
    env: { ...process.env, DCW_DATA_ROOT: dataRoot, DCW_PORT: port, DCW_LOG_LEVEL: "debug" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  child.verifyLines = lines;
  children.push(child);
  child.stdout.on("data", (data) => lines.push(data.toString()));
  child.stderr.on("data", (data) => lines.push(data.toString()));
  child.on("exit", (code, signal) => {
    lines.push(`[verify] server exit code=${String(code)} signal=${String(signal)}\n`);
    void writeFile(join(runRoot, logName), lines.join(""));
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) {
        await writeFile(join(runRoot, logName), lines.join(""));
        return child;
      }
    } catch {
    }
    await sleep(100);
  }
  await stop(child);
  throw new Error("server did not start");
}

async function session() {
  const response = await fetch(`${base}/api/v1/health`);
  const body = await response.json();
  const cookies = response.headers.getSetCookie();
  const cookie = cookies[0]?.split(";")[0];
  if (cookie === undefined) throw new Error("session cookie missing");
  return { cookie, csrfToken: body.data.csrfToken };
}

async function json(path, cookie = auth?.cookie) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function post(path, body) {
  if (auth === null) throw new Error("session missing");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      "content-type": "application/json",
      "x-csrf-token": auth.csrfToken,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { statusCode: response.status, body: await response.json() };
}

async function createJob(path, body) {
  const response = await post(path, body);
  if (response.statusCode !== 202) throw new Error(`job create returned ${response.statusCode}`);
  return response.body;
}

async function waitForJob(id, predicate, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const body = await json(`/api/v1/jobs/${id}`);
    if (predicate(body.data)) return body.data;
    await sleep(100);
  }
  throw new Error(`job ${id} did not reach expected state`);
}

async function readSse(id, lastEventId) {
  if (auth === null) throw new Error("session missing");
  const controller = new AbortController();
  const response = await fetch(`${base}/api/v1/jobs/${id}/events`, {
    headers: {
      cookie: auth.cookie,
      ...(lastEventId === 0 ? {} : { "Last-Event-ID": String(lastEventId) }),
    },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) events.push(JSON.parse(data.slice(6)));
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

async function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeout),
  ]);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 4_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error(`process ${child.pid} did not exit`);
}

async function check(name, fn) {
  try {
    return { name, ok: await fn() };
  } catch {
    return { name, ok: false };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
