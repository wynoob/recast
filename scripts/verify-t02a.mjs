import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";

const evidenceRoot =
  process.env.DCW_EVIDENCE_ROOT ??
  "/Users/wangyun/Projects/AI-Harness/agent-evidence/dmall-content-workbench/recast-20261021/t02a";
const runRoot = join(evidenceRoot, `runtime-${Date.now()}`);
const fullFixture = join(
  process.cwd(),
  "input/Dmall内容工作台-完整交接包-v1.0/materials/local",
);
const checks = [];
const observations = {};
const startedAt = new Date().toISOString();

await mkdir(runRoot, { recursive: true });
const build = spawnSync(process.execPath, [process.env.DCW_BACKEND_ONLY === "1" ? "scripts/backend-check.mjs" : "scripts/build.mjs"], { stdio: "inherit", env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);

try {
  const sample = await createSampleFixture();
  const server = await startServer("server-sample.log");
  try {
    const auth = await session(server.origin);
    const scan = await createScan(server.origin, auth, {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: sample.root,
      options: { generatePreviews: true },
    });
    const scanDetail = await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/scans/${scan.scanId}`),
      (value) => value.status === "ready",
      "sample scan",
      30_000,
    );
    checks.push({
      name: "scan_sample_counts",
      ok:
        scanDetail.counts.mp4 === 2 &&
        scanDetail.counts.gif === 2 &&
        scanDetail.counts.image === 1 &&
        scanDetail.counts.markdown === 1,
      observed: scanDetail.counts,
    });
    const blobCountBefore = countRows(server.dataRoot, "blobs");
    checks.push({ name: "scan_does_not_copy", ok: blobCountBefore === 0, observed: blobCountBefore });

    const imported = await createImport(server.origin, auth, scan.scanId, "all");
    const importDetail = await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/${imported.importId}`),
      (value) => ["succeeded", "partial", "failed"].includes(value.status),
      "sample import",
      120_000,
    );
    checks.push({
      name: "sample_import_complete",
      ok: importDetail.status === "succeeded" && importDetail.counts.failed === 0,
      observed: { status: importDetail.status, counts: importDetail.counts },
    });

    const assets = await getJson(server.origin, auth, "/api/v1/assets?limit=100");
    const kinds = Object.fromEntries(
      ["image", "gif", "video"].map((kind) => [
        kind,
        assets.items.filter((item) => item.mediaKind === kind).length,
      ]),
    );
    checks.push({
      name: "asset_groups",
      ok: kinds.image >= 1 && kinds.gif >= 2 && kinds.video >= 2,
      observed: { total: assets.total, kinds, groupCounts: assets.groupCounts },
    });

    const previewChecks = [];
    for (const asset of assets.items) {
      const original = await fetch(`${server.origin}${asset.originalFileUrl}`, {
        headers: { cookie: auth.cookie },
      });
      const originalBytes = Buffer.from(await original.arrayBuffer());
      const originalHash = createHash("sha256").update(originalBytes).digest("hex");
      const preview = await fetch(`${server.origin}${asset.previewFileUrl}`, {
        headers: { cookie: auth.cookie },
      });
      const previewBytes = Buffer.from(await preview.arrayBuffer());
      let previewDecodable = false;
      if (asset.mediaKind === "video") {
        const previewPath = join(runRoot, `preview-${asset.id}.mp4`);
        await writeFile(previewPath, previewBytes);
        const probe = spawnSync("ffprobe", [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_streams",
          previewPath,
        ], { encoding: "utf8" });
        previewDecodable =
          probe.status === 0 &&
          JSON.parse(probe.stdout).streams.some((stream) => stream.codec_type === "video");
      } else {
        const metadata = await sharp(previewBytes).metadata();
        previewDecodable = (metadata.width ?? 0) > 0 && (metadata.height ?? 0) > 0;
      }
      previewChecks.push({
        id: asset.id,
        kind: asset.mediaKind,
        hashMatches: originalHash === basename(asset.originalFileUrl),
        previewDecodable,
        bytes: originalBytes.byteLength,
      });
    }
    checks.push({
      name: "originals_and_previews_decodable",
      ok: previewChecks.every((item) => item.hashMatches && item.previewDecodable),
      observed: previewChecks,
    });

    const source = readRows(server.dataRoot, "SELECT id FROM sources WHERE kind = 'local_markdown'")[0];
    const sourceContext = await getJson(server.origin, auth, `/api/v1/sources/${source.id}`);
    const markdown = sourceContext.occurrences;
    checks.push({
      name: "markdown_occurrences",
      ok:
        markdown.length === 4 &&
        markdown.some((item) => item.mediaStatus === "missing") &&
        markdown.some((item) => item.mediaStatus === "available" && item.locator.kind === "markdown") &&
        markdown.some((item) => item.mediaStatus === "unsupported") &&
        markdown.every((item) => item.locator.kind !== "markdown" || item.locator.blockId === undefined) &&
        markdown.filter((item) => item.locator.kind === "markdown").every((item) => item.beforeText.length <= 1000 && item.afterText.length <= 1000),
      observed: markdown,
    });

    const fullScan = await createScan(server.origin, auth, {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: fullFixture,
      options: { generatePreviews: true },
    });
    const fullDetail = await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/scans/${fullScan.scanId}`),
      (value) => value.status === "ready",
      "full fixture scan",
      60_000,
    );
    checks.push({
      name: "full_fixture_scan_counts",
      ok:
        fullDetail.counts.mp4 === 11 &&
        fullDetail.counts.gif === 12 &&
        fullDetail.counts.image === 1 &&
        fullDetail.counts.markdown === 2 &&
        fullDetail.counts.unsupported >= 1,
      observed: fullDetail.counts,
    });

    const pngAsset = assets.items.find((item) => item.mediaKind === "image");
    const pngPath = join(fullFixture, "public/assets/brand/dmall-logo.png");
    const uploaded = await uploadChunks(server.origin, auth, pngPath, "uploads/dmall-logo.png", 3);
    const uploadScan = await createScan(server.origin, auth, {
      schemaVersion: 1,
      sourceKind: "upload",
      fileIds: [uploaded.fileId],
      options: { generatePreviews: true },
    });
    await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/scans/${uploadScan.scanId}`),
      (value) => value.status === "ready",
      "upload scan",
      30_000,
    );
    const uploadImport = await createImport(server.origin, auth, uploadScan.scanId, "all");
    await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/${uploadImport.importId}`),
      (value) => value.status === "succeeded",
      "upload import",
      60_000,
    );
    const dedupAsset = readRows(
      server.dataRoot,
      "SELECT id FROM assets WHERE blob_hash = '18a0836442b0f6086edb077cdcbaa3f8917a29a400651c1e1a7bc88affbb3622'",
    )[0];
    const dedupOccurrences = readRows(
      server.dataRoot,
      `SELECT COUNT(*) AS count FROM occurrences WHERE asset_id = '${dedupAsset.id}'`,
    )[0].count;
    checks.push({
      name: "cross_source_dedup",
      ok: dedupAsset.id === pngAsset.id && dedupOccurrences >= 3,
      observed: { assetId: dedupAsset.id, occurrences: dedupOccurrences },
    });

    const patchKey = randomUUID();
    const patchBody = {
      schemaVersion: 1,
      expectedVersion: 0,
      title: "人工确认标题",
      tags: ["品牌", "Logo"],
    };
    const patched = await writeJson(server.origin, auth, "PATCH", `/api/v1/assets/${pngAsset.id}`, patchBody, patchKey);
    const patchedReplay = await writeJson(server.origin, auth, "PATCH", `/api/v1/assets/${pngAsset.id}`, patchBody, patchKey);
    const conflict = await rawJson(server.origin, auth, "PATCH", `/api/v1/assets/${pngAsset.id}`, {
      schemaVersion: 1,
      expectedVersion: 0,
      title: "过期写入",
    });
    checks.push({
      name: "asset_cas_and_idempotency",
      ok:
        patched.data.version === 1 &&
        JSON.stringify(patched) === JSON.stringify(patchedReplay) &&
        conflict.status === 409 &&
        conflict.body.error.code === "ASSET_VERSION_CONFLICT",
      observed: { patched, conflict },
    });

    const rangeHash = assets.items.find((item) => item.mediaKind === "image").originalFileUrl.split("/").at(-1);
    const originalPath = join(sample.root, "assets/logo.png");
    const originalBytes = await readFile(originalPath);
    const rangeResponse = await fetch(`${server.origin}/api/v1/files/${rangeHash}`, {
      headers: { cookie: auth.cookie, range: "bytes=13-76" },
    });
    const rangeBytes = Buffer.from(await rangeResponse.arrayBuffer());
    const headResponse = await fetch(`${server.origin}/api/v1/files/${rangeHash}`, {
      method: "HEAD",
      headers: { cookie: auth.cookie },
    });
    checks.push({
      name: "file_range_etag_head",
      ok:
        rangeResponse.status === 206 &&
        rangeBytes.equals(originalBytes.subarray(13, 77)) &&
        headResponse.status === 200 &&
        headResponse.headers.get("etag") === `"${rangeHash}"` &&
        headResponse.headers.get("content-type") === "image/png",
      observed: {
        status: rangeResponse.status,
        contentRange: rangeResponse.headers.get("content-range"),
        etag: headResponse.headers.get("etag"),
        contentType: headResponse.headers.get("content-type"),
      },
    });
    observations.sample = { scanDetail, importDetail, assets, markdown, fullFull: fullDetail.counts };
  } finally {
    await stopServer(server);
  }

  const bigVideo = await createBigVideo();
  const workerKill = await lifecycleCheck(bigVideo, "worker-sigkill");
  checks.push({
    name: "worker_sigkill_kills_media_descendants",
    ok: workerKill.ffmpegGone,
    observed: workerKill,
  });

  const cancel = await cancelCheck(bigVideo);
  checks.push({
    name: "cancel_terminates_media_and_keeps_committed",
    ok: cancel.ffmpegGone && cancel.status === "cancelled" && cancel.committed >= 1,
    observed: cancel,
  });

  const apiKill = await apiKillCheck(bigVideo, "api-sigkill");
  checks.push({
    name: "api_sigkill_kills_media_descendants",
    ok: apiKill.ffmpegGone && apiKill.workersGone,
    observed: apiKill,
  });

  const failed = checks.filter((check) => !check.ok);
  const result = {
    schemaVersion: 1,
    stage: "T02a",
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    observations,
    scope: "sample media import + full-fixture scan + real ffmpeg lifecycle; full 24-media import remains T02b",
  };
  await writeFile(join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: result.passed, failed: result.failed, runRoot }, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  const result = {
    schemaVersion: 1,
    stage: "T02a",
    startedAt,
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    checks,
    observations,
  };
  await writeFile(join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  throw error;
}

async function createSampleFixture() {
  const root = await mkdtemp(join(runRoot, "sample-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await copyFile(join(fullFixture, "public/assets/brand/dmall-logo.png"), join(root, "assets/logo.png"));
  const gifs = (await readdir(join(fullFixture, "public/assets/reference")))
    .filter((name) => name.endsWith(".gif"))
    .sort();
  await copyFile(join(fullFixture, "public/assets/reference", gifs[0]), join(root, "assets/one.gif"));
  await copyFile(join(fullFixture, "public/assets/reference", gifs[1]), join(root, "assets/two.gif"));
  await copyFile(join(fullFixture, "public/assets/素材-昨日销量情况.mp4"), join(root, "assets/demo.mp4"));
  await copyFile(join(fullFixture, "public/assets/source/DD-3.mp4"), join(root, "assets/second.mp4"));
  await writeFile(
    join(root, "notes.md"),
    [
      "# 章节 A",
      "",
      "上下文一。",
      "",
      "上下文二。",
      "",
      "![已有](assets/logo.png)",
      "",
      "![缺失](./missing.png)",
      "",
      "![引用][pic]",
      "",
      "上下文三。",
      "",
      "![外链](https://example.com/no.png)",
      "",
      "[pic]: assets/logo.png",
      "",
    ].join("\n"),
  );
  return { root };
}

async function createBigVideo() {
  const path = join(runRoot, "big.mp4");
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30:duration=20",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-y",
    path,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`big video generation failed: ${result.stderr}`);
  return path;
}

async function lifecycleCheck(bigVideoPath, name) {
  const root = await mkdtemp(join(runRoot, `${name}-fixture-`));
  await copyFile(bigVideoPath, join(root, "big.mp4"));
  const server = await startServer(`${name}-server.log`);
  try {
    const auth = await session(server.origin);
    const scan = await createScan(server.origin, auth, {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: root,
      options: { generatePreviews: true },
    });
    await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/scans/${scan.scanId}`),
      (value) => value.status === "ready",
      `${name} scan`,
      30_000,
    );
    const imported = await createImport(server.origin, auth, scan.scanId, "all");
    const media = await waitForMediaProcess(imported.importId, 30_000);
    const workers = workerIdentities(server.process.pid);
    for (const worker of workers) {
      try {
        process.kill(worker.pid, "SIGKILL");
      } catch {
      }
    }
    const gone = await waitUntil(
      () => media.every((item) => !identityAlive(item)),
      5_000,
    );
    try {
      await rawJson(server.origin, auth, "POST", `/api/v1/jobs/${imported.jobId}/cancel`, {});
    } catch {
    }
    return {
      workerPids: workers.map((worker) => worker.pid),
      media,
      ffmpegGone: gone,
      cancelAfterKill: true,
    };
  } finally {
    await stopServer(server);
  }
}

async function cancelCheck(bigVideoPath) {
  const root = await mkdtemp(join(runRoot, "cancel-fixture-"));
  await copyFile(join(fullFixture, "public/assets/brand/dmall-logo.png"), join(root, "a.png"));
  await copyFile(bigVideoPath, join(root, "z.mp4"));
  const server = await startServer("cancel-server.log");
  try {
    const auth = await session(server.origin);
    const scan = await createScan(server.origin, auth, {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: root,
      options: { generatePreviews: true },
    });
    await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/scans/${scan.scanId}`),
      (value) => value.status === "ready",
      "cancel scan",
      30_000,
    );
    const imported = await createImport(server.origin, auth, scan.scanId, "all");
    const media = await waitForMediaProcess(imported.importId, 30_000);
    await rawJson(server.origin, auth, "POST", `/api/v1/jobs/${imported.jobId}/cancel`, {});
    const detail = await waitFor(
      () => getJson(server.origin, auth, `/api/v1/imports/${imported.importId}`),
      (value) => value.status === "cancelled",
      "cancel import",
      15_000,
    );
    const gone = await waitUntil(() => media.every((item) => !identityAlive(item)), 5_000);
    return {
      media,
      ffmpegGone: gone,
      status: detail.status,
      committed: detail.counts.committed,
      counts: detail.counts,
    };
  } finally {
    await stopServer(server);
  }
}

async function apiKillCheck(bigVideoPath, name) {
  const root = await mkdtemp(join(runRoot, `${name}-fixture-`));
  await copyFile(bigVideoPath, join(root, "big.mp4"));
  const server = await startServer(`${name}-server.log`);
  const auth = await session(server.origin);
  const scan = await createScan(server.origin, auth, {
    schemaVersion: 1,
    sourceKind: "local_directory",
    rootPath: root,
    options: { generatePreviews: true },
  });
  await waitFor(
    () => getJson(server.origin, auth, `/api/v1/imports/scans/${scan.scanId}`),
    (value) => value.status === "ready",
    `${name} scan`,
    30_000,
  );
  const imported = await createImport(server.origin, auth, scan.scanId, "all");
  const media = await waitForMediaProcess(imported.importId, 30_000);
  const workers = workerIdentities(server.process.pid);
  server.process.kill("SIGKILL");
  await waitForExit(server.process, 3_000);
  const ffmpegGone = await waitUntil(() => media.every((item) => !identityAlive(item)), 5_000);
  const workersGone = await waitUntil(
    () => workers.every((worker) => !identityAlive(worker)),
    5_000,
  );
  return { workerPids: workers.map((worker) => worker.pid), media, ffmpegGone, workersGone };
}

async function startServer(logName) {
  const dataRoot = await mkdtemp(join(runRoot, "data-"));
  const port = await freePort();
  const logPath = join(runRoot, logName);
  const log = await import("node:fs").then(({ openSync }) => openSync(logPath, "a"));
  const child = spawn(process.execPath, ["dist/apps/server/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DCW_DATA_ROOT: dataRoot,
      DCW_PORT: String(port),
      DCW_LOG_LEVEL: "info",
    },
    stdio: ["ignore", log, log],
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      try {
        return await getJsonRaw(`${origin}/api/v1/health`);
      } catch {
        return null;
      }
    },
    (value) => value?.data?.status === "ok",
    `server ${logName}`,
    20_000,
  );
  return { process: child, origin, dataRoot, logPath };
}

async function stopServer(server) {
  if (server.process.exitCode !== null || server.process.signalCode !== null) return;
  server.process.kill("SIGTERM");
  await waitForExit(server.process, 8_000);
}

async function session(origin) {
  const response = await fetch(`${origin}/api/v1/health`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  const body = await response.json();
  return { cookie, csrf: body.data.csrfToken };
}

async function createScan(origin, auth, body) {
  return (await writeJson(origin, auth, "POST", "/api/v1/imports/scan", body)).data;
}

async function createImport(origin, auth, scanId, mode) {
  return (
    await writeJson(origin, auth, "POST", "/api/v1/imports", {
      schemaVersion: 1,
      scanId,
      selection: { mode, includeItemIds: [], excludeItemIds: [] },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    })
  ).data;
}

async function uploadChunks(origin, auth, path, relativePath, chunkCount) {
  const bytes = await readFile(path);
  const size = Math.ceil(bytes.byteLength / chunkCount);
  let fileId;
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.subarray(index * size, Math.min(bytes.byteLength, (index + 1) * size));
    const form = new FormData();
    if (fileId !== undefined) form.set("fileId", fileId);
    if (index === 0) {
      form.set("relativePath", relativePath);
      form.set("declaredBytes", String(bytes.byteLength));
    }
    form.set("chunkIndex", String(index));
    form.set("chunkCount", String(chunkCount));
    form.set("chunkSha256", createHash("sha256").update(chunk).digest("hex"));
    form.set("file", new Blob([chunk]), "chunk.bin");
    const response = await fetch(`${origin}/api/v1/uploads`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "Idempotency-Key": randomUUID(),
      },
      body: form,
    });
    const body = await response.json();
    if (response.status !== 201) throw new Error(`upload failed: ${JSON.stringify(body)}`);
    fileId = body.data.fileId;
    if (index === chunkCount - 1) return body.data;
  }
  throw new Error("upload did not finish");
}

async function getJson(origin, auth, path) {
  const response = await fetch(`${origin}${path}`, { headers: { cookie: auth.cookie } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${JSON.stringify(body)}`);
  return body.data;
}

async function getJsonRaw(url) {
  const response = await fetch(url);
  return response.json();
}

async function writeJson(origin, auth, method, path, body, key = randomUUID()) {
  const response = await rawJson(origin, auth, method, path, body, key);
  if (response.status >= 400) throw new Error(`${path} failed ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function rawJson(origin, auth, method, path, body, key = randomUUID()) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "Idempotency-Key": key,
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForMediaProcess(importId, timeoutMs) {
  let found = [];
  const matched = await waitUntil(() => {
    found = processIdentities().filter(
      (identity) =>
        identity.command.includes(`staging/jobs/${importId}`) &&
        identity.command.includes("preview.mp4") &&
        identity.command.includes("ffmpeg"),
    );
    return found.length > 0;
  }, timeoutMs);
  if (!matched || found.length === 0) {
    throw new Error(`media process not observed for import ${importId}`);
  }
  return found;
}

async function waitFor(fn, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`${label} timeout`);
}

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

function countRows(dataRoot, table) {
  return readRows(dataRoot, `SELECT COUNT(*) AS count FROM ${table}`)[0].count;
}

function readRows(dataRoot, sql) {
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()));
    db.close();
  `;
  const result = spawnSync(process.execPath, ["-e", script, join(dataRoot, "db/workbench.sqlite"), sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

function processIdentities() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8" });
  return result.stdout.split("\n").flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) return [];
    return [{
      pid: Number(parts[0]),
      parentPid: Number(parts[1]),
      startedAt: parts.slice(2, 7).join(" "),
      command: parts.slice(7).join(" "),
    }];
  });
}

function workerIdentities(parentPid) {
  return processIdentities().filter(
    (identity) =>
      identity.parentPid === parentPid &&
      identity.command.includes("dist/apps/worker/main.js"),
  );
}

function identityAlive(identity) {
  return processIdentities().some(
    (row) =>
      row.pid === identity.pid &&
      row.startedAt === identity.startedAt &&
      row.command === identity.command,
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
