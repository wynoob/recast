import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";

const ROOT = process.cwd();
const EVIDENCE_ROOT = process.env.DCW_T02B_EVIDENCE ??
  "/Users/wangyun/Projects/AI-Harness/agent-evidence/dmall-content-workbench/recast-20261021/t02b";
const RUN = join(EVIDENCE_ROOT, `runtime-${process.env.DCW_T02B_RUN ?? Date.now()}`);
const DATA_ROOT = join(RUN, "data");
const PORT = process.env.DCW_T02B_PORT ?? "4337";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_ROOT = join(
  ROOT,
  "input",
  "Dmall内容工作台-完整交接包-v1.0",
  "materials",
  "local",
);
const BASELINE_PATH = process.env.DCW_FIXTURE_BASELINE ?? join(
  ROOT,
  "..",
  "AI-Harness",
  "agent-evidence",
  "dmall-content-workbench",
  "recast-20261021",
  "fixture-baseline",
  "result.json",
);
const SCREENSHOTS = join(RUN, "screenshots");
const TMP = join(RUN, "tmp");
const STEPS = [];
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(ROOT, ".tools", "ms-playwright");
const { chromium } = await import("@playwright/test");

await mkdir(DATA_ROOT, { recursive: true });
await mkdir(SCREENSHOTS, { recursive: true });
await mkdir(TMP, { recursive: true });

const result = {
  schemaVersion: 1,
  stage: "T02b",
  scope: "frontend integration against real T02a API and 24-media fixture",
  startedAt: new Date().toISOString(),
  fixtureRoot: FIXTURE_ROOT,
  dataRoot: DATA_ROOT,
  baseUrl: BASE_URL,
  steps: STEPS,
  status: "running",
};

const serverLog = await import("node:fs").then(({ createWriteStream }) =>
  createWriteStream(join(RUN, "server.log"), { flags: "a" }),
);
const server = spawn(process.execPath, ["dist/apps/server/main.js"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    DCW_DATA_ROOT: DATA_ROOT,
    DCW_PORT: PORT,
    DCW_WEB_ROOT: join(ROOT, "dist", "web"),
    DCW_LOG_LEVEL: "warn",
  },
});
server.stdout.pipe(serverLog);
server.stderr.pipe(serverLog);

let browser;
try {
  await waitForServer();
  step("server", "pass", { pid: server.pid });
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  const baselineHashes = new Set(baseline.localMedia.map((item) => item.sha256));
  const rootBefore = await hashTree(FIXTURE_ROOT);
  await save("fixture-root-before.json", rootBefore);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const consoleMessages = [];
  page.on("console", (message) => {
    consoleMessages.push({ level: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({ level: "pageerror", text: error.message });
  });

  const health = await apiData(context.request, "GET", "/api/v1/health");
  const csrf = health.data.csrfToken;

  await page.goto("/assets");
  await page.getByRole("heading", { name: "素材库为空" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "导入素材" }).click();
  const importDialog = page.getByRole("dialog");
  await importDialog.getByLabel("本次要扫描的文件夹路径").fill(FIXTURE_ROOT);
  await importDialog.getByRole("button", { name: "开始扫描" }).click();
  await importDialog.getByRole("heading", { name: "确认导入范围" }).waitFor({ timeout: 120_000 });
  const confirmText = await importDialog.innerText();
  ensure(confirmText.includes("24 媒体 + 2 文档"), "确认页没有显示 24 媒体 + 2 文档");
  ensure(confirmText.includes("11 MP4 · 12 GIF · 1 图片"), "确认页没有显示 11/12/1 媒体计数");
  await importDialog.locator(".confirm-copy input[type=checkbox]").check();
  await importDialog.getByRole("button", { name: "确认导入 26 项" }).click();
  await importDialog.getByText("关闭不等于取消").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(SCREENSHOTS, "import-running-1280.png"), fullPage: true });
  step("ui-scan-confirm", "pass", { confirmText: summarize(confirmText) });

  await page.reload();
  await page.getByRole("button", { name: "任务" }).click();
  const tasksDialog = page.getByRole("dialog");
  const importTask = tasksDialog.locator(".task-card", { hasText: "26 / 26 项已完成" });
  await importTask.waitFor({ timeout: 600_000 });
  await page.screenshot({ path: join(SCREENSHOTS, "task-drawer-complete-1280.png") });
  await importTask.getByRole("button", { name: "查看素材" }).click();
  await page.getByText("共 24 项", { exact: false }).waitFor({ timeout: 60_000 });
  step("ui-import-24", "pass");

  const assetsFirst = await apiData(context.request, "GET", "/api/v1/assets?limit=100");
  ensure(assetsFirst.data.items.length === 24, `素材列表应有 24 项，实际 ${assetsFirst.data.items.length}`);
  const importedHashes = new Set(assetsFirst.data.items.map((item) => hashFromUrl(item.originalFileUrl)));
  ensure(setsEqual(importedHashes, baselineHashes), "导入素材 hash 集合与 fixture-baseline 不一致");
  await save("assets-after-first-import.json", assetsFirst.data);

  await page.getByRole("button", { name: "视频", exact: true }).click();
  const videoCard = page.locator(".asset-card").first();
  await videoCard.waitFor({ timeout: 30_000 });
  const videoAssetId = await videoCard.getAttribute("data-asset-id");
  ensure(videoAssetId !== null, "素材卡缺少 asset id");
  await videoCard.click();
  const detailDialog = page.getByRole("dialog");
  const video = detailDialog.locator("video[data-testid=asset-video]");
  await video.waitFor({ timeout: 30_000 });
  ensure(await video.evaluate((element) => element.controls), "视频元素没有 controls");
  await waitForVideo(video);
  const seekedTime = await seekVideo(video);
  ensure(seekedTime > 0, "视频 seek 后 currentTime 仍为 0");
  await page.screenshot({ path: join(SCREENSHOTS, "asset-detail-video-1280.png") });
  step("ui-video-seek", "pass", { assetId: videoAssetId, currentTime: seekedTime });

  const titleInput = detailDialog.getByLabel(/^标题/);
  const tagsInput = detailDialog.getByLabel(/^标签/);
  const stamp = String(Date.now()).slice(-7);
  const manualTitle = `人工标题 ${stamp}`;
  await titleInput.fill(manualTitle);
  await tagsInput.fill("经营诊断, 昨日销量");
  await detailDialog.getByRole("button", { name: "保存修改" }).click();
  await detailDialog.getByText(/已保存为新版本/).waitFor({ timeout: 30_000 });
  await page.reload();
  await page.getByPlaceholder("搜索标题或标签").fill(manualTitle);
  const manualCard = page.locator(`.asset-card[data-asset-id="${videoAssetId}"]`);
  await manualCard.waitFor({ timeout: 30_000 });
  await manualCard.click();
  await page.getByRole("dialog").getByLabel(/^标题/).waitFor({ timeout: 30_000 });
  ensure(await page.getByRole("dialog").getByLabel(/^标题/).inputValue() === manualTitle, "刷新后人工标题未保留");
  ensure((await page.getByRole("dialog").getByLabel(/^标签/).inputValue()).includes("经营诊断"), "刷新后人工标签未保留");
  step("ui-manual-reload", "pass", { title: manualTitle });

  const detailBeforeConflict = await apiData(context.request, "GET", `/api/v1/assets/${videoAssetId}`);
  const externalTitle = `另一处修改 ${stamp}`;
  await apiData(context.request, "PATCH", `/api/v1/assets/${videoAssetId}`, {
    csrf,
    body: {
      schemaVersion: 1,
      expectedVersion: detailBeforeConflict.data.summary.version,
      title: externalTitle,
    },
  });
  const myConflictTitle = `保留输入 ${stamp}`;
  const conflictDialog = page.getByRole("dialog");
  await conflictDialog.getByLabel(/^标题/).fill(myConflictTitle);
  await conflictDialog.getByRole("button", { name: "保存修改" }).click();
  await conflictDialog.getByText("素材已被另一处修改，已载入最新版本。").waitFor({ timeout: 30_000 });
  ensure(await conflictDialog.getByLabel(/^标题/).inputValue() === myConflictTitle, "冲突后用户输入被自动覆盖");
  await page.screenshot({ path: join(SCREENSHOTS, "asset-conflict-1280.png") });
  await conflictDialog.getByRole("button", { name: "保留我的输入" }).click();
  await conflictDialog.getByRole("button", { name: "保存修改" }).click();
  await conflictDialog.getByText(/已保存为新版本/).waitFor({ timeout: 30_000 });
  const afterConflict = await apiData(context.request, "GET", `/api/v1/assets/${videoAssetId}`);
  ensure(afterConflict.data.humanFields.title === myConflictTitle, "冲突恢复后标题不是用户输入");
  step("ui-conflict", "pass", { externalTitle, keptTitle: myConflictTitle });

  await conflictDialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.goto("/assets");
  await page.getByRole("button", { name: "导入素材" }).click();
  const uploadDialog = page.getByRole("dialog");
  await uploadDialog.getByRole("button", { name: "上传文件或目录" }).click();
  await uploadDialog.getByTestId("upload-files").setInputFiles(
    join(FIXTURE_ROOT, "public/assets/brand/dmall-logo.png"),
  );
  await uploadDialog.getByRole("button", { name: "上传并扫描" }).click();
  await uploadDialog.getByRole("heading", { name: "确认导入范围" }).waitFor({ timeout: 120_000 });
  ensure((await uploadDialog.innerText()).includes("1 媒体 + 0 文档"), "上传入口确认页计数不正确");
  await uploadDialog.locator(".confirm-copy input[type=checkbox]").check();
  await uploadDialog.getByRole("button", { name: "确认导入 1 项" }).click();
  await uploadDialog.getByText("已导入 1 项").waitFor({ timeout: 120_000 });
  await page.screenshot({ path: join(SCREENSHOTS, "upload-single-file-1280.png") });
  await uploadDialog.getByRole("button", { name: "查看素材" }).click();
  const uploadSource = await readFile(join(ROOT, "apps/web/src/features/assets/api.ts"), "utf8");
  const multipartOrder = checkMultipartOrder(uploadSource);
  ensure(multipartOrder.ok, "上传 multipart 的元数据字段没有全部位于 file 字段之前");
  await save("multipart-order.json", multipartOrder);
  const assetsAfterUpload = await apiData(context.request, "GET", "/api/v1/assets?limit=100");
  ensure(assetsAfterUpload.data.total === 24, "同一 hash 的上传入口导入后素材数不应增加");
  step("ui-upload", "pass", { assets: assetsAfterUpload.data.total, multipartOrder });

  const db = new Database(join(DATA_ROOT, "db", "workbench.sqlite"), { readonly: true });
  const countsAfterFirst = dbCounts(db);
  await save("db-after-first.json", countsAfterFirst);
  ensure(countsAfterFirst.assets === 24, "DB assets 不是 24");
  ensure(countsAfterFirst.importItems.committed >= 27, "DB 已提交项目不足 27（26 目录 + 1 上传）");
  const mediaVerification = await verifyOriginalAndDerivatives(context.request, db, baseline);
  await save("media-verification.json", mediaVerification);
  ensure(mediaVerification.originals.length === 24, "原件逐项核验不是 24");
  ensure(mediaVerification.videoPreviewsDecoded === 11, "视频预览可解码数量不是 11");
  ensure(mediaVerification.postersDecoded === 24, "海报可解码数量不是 24");
  step("media-hash-preview", "pass", summarizeMediaVerification(mediaVerification));

  const rangeVerification = await verifyRange(context.request, assetsFirst.data.items);
  await save("range-verification.json", rangeVerification);
  step("range-etag", "pass", rangeVerification);

  const markdownVerification = await verifyMarkdown(context.request, db);
  await save("markdown-verification.json", markdownVerification);
  step("markdown-sources", "pass", markdownVerification);

  const assetMapVerification = await verifyAssetMap(baseline);
  await save("asset-map-verification.json", assetMapVerification);
  step("asset-map", "pass", assetMapVerification);

  const blobFilesBefore = await countFiles(join(DATA_ROOT, "blobs", "sha256"));
  const duplicateScan = await apiData(context.request, "POST", "/api/v1/imports/scan", {
    csrf,
    body: {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: FIXTURE_ROOT,
      options: { generatePreviews: true },
    },
  });
  await pollJob(context.request, duplicateScan.data.jobId, 120_000);
  const duplicateScanDetail = await apiData(
    context.request,
    "GET",
    `/api/v1/imports/scans/${duplicateScan.data.scanId}`,
  );
  ensure(duplicateScanDetail.data.counts.candidate === 26, "第二次扫描候选数不是 26");
  const duplicateItems = await apiData(
    context.request,
    "GET",
    `/api/v1/imports/scans/${duplicateScan.data.scanId}/items?status=candidate&limit=100`,
  );
  const duplicateImport = await apiData(context.request, "POST", "/api/v1/imports", {
    csrf,
    body: {
      schemaVersion: 1,
      scanId: duplicateScan.data.scanId,
      selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    },
  });
  await pollJob(context.request, duplicateImport.data.jobId, 600_000);
  const duplicateDetail = await apiData(
    context.request,
    "GET",
    `/api/v1/imports/${duplicateImport.data.importId}?limit=100`,
  );
  ensure(duplicateDetail.data.status === "succeeded", `重复导入状态不是 succeeded: ${duplicateDetail.data.status}`);
  const countsAfterDuplicate = dbCounts(db);
  const blobFilesAfter = await countFiles(join(DATA_ROOT, "blobs", "sha256"));
  const duplicateCompare = {
    before: countsAfterFirst,
    after: countsAfterDuplicate,
    blobFilesBefore,
    blobFilesAfter,
    candidateItems: duplicateItems.data.total,
  };
  await save("duplicate-compare.json", duplicateCompare);
  ensure(countsAfterDuplicate.assets === countsAfterFirst.assets, "重复导入增加了 assets");
  ensure(countsAfterDuplicate.blobs === countsAfterFirst.blobs, "重复导入增加了 blobs");
  ensure(blobFilesAfter === blobFilesBefore, "重复导入增加了原件或派生文件");
  ensure(countsAfterDuplicate.sources === countsAfterFirst.sources, "重复导入增加了 sources");
  ensure(countsAfterDuplicate.sourceVersions === countsAfterFirst.sourceVersions, "重复导入增加了来源版本");
  ensure(countsAfterDuplicate.occurrences === countsAfterFirst.occurrences, "同一来源位置被重复写成新的出现位置");
  ensure(
    countsAfterDuplicate.importItems.total === countsAfterFirst.importItems.total + 26,
    "重复导入没有为 26 个扫描项目建立幂等导入记录",
  );
  const crossSource = db
    .prepare(
      `SELECT a.blob_hash AS hash, COUNT(DISTINCT sv.source_id) AS sources, COUNT(*) AS occurrences
       FROM assets a
       JOIN occurrences o ON o.asset_id = a.id
       JOIN source_versions sv ON sv.id = o.source_version_id
       GROUP BY a.id HAVING COUNT(DISTINCT sv.source_id) >= 2`,
    )
    .all();
  ensure(crossSource.length >= 1, "同一 hash 的跨来源出现位置没有保留");
  await save("cross-source-occurrences.json", crossSource);
  step("dedup-second-import", "pass", {
    assets: countsAfterDuplicate.assets,
    blobs: countsAfterDuplicate.blobs,
    occurrences: countsAfterDuplicate.occurrences,
    importItems: countsAfterDuplicate.importItems.total,
    crossSource,
  });

  await page.goto("/assets");
  for (const width of [1280, 728, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/assets");
    await page.locator(".asset-card").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    ensure(await page.locator(".dialog-backdrop").count() === 0, `${width}px 素材库截图前仍有遮罩`);
    ensure(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${width}px 素材库横向溢出`);
    await page.screenshot({ path: join(SCREENSHOTS, `assets-${width}.png`) });
    await page.locator(".asset-card").first().click();
    await page.getByRole("dialog").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    ensure(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${width}px 详情横向溢出`);
    await page.screenshot({ path: join(SCREENSHOTS, `detail-${width}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
  }
  const pageText = await page.locator("body").innerText();
  const forbidden = findForbidden(pageText);
  ensure(forbidden.length === 0, `界面出现内部术语: ${forbidden.join(", ")}`);
  step("responsive-screenshots", "pass", { forbiddenTerms: forbidden });

  const rootAfter = await hashTree(FIXTURE_ROOT);
  await save("fixture-root-after.json", rootAfter);
  ensure(rootBefore.digest === rootAfter.digest, "扫描或导入改动了 fixture 原始目录");
  await save("ui-console.json", consoleMessages);
  const unexpectedConsole = consoleMessages.filter(
    (message) =>
      (message.level === "error" || message.level === "pageerror") &&
      !message.text.includes("status of 409 (Conflict)"),
  );
  ensure(
    unexpectedConsole.length === 0,
    `浏览器出现未预期控制台错误: ${unexpectedConsole.map((message) => message.text).join("; ")}`,
  );
  step("fixture-read-only", "pass", { digest: rootAfter.digest });

  db.close();
  result.status = "passed";
  result.finishedAt = new Date().toISOString();
  result.counts = {
    assets: countsAfterDuplicate.assets,
    blobs: countsAfterDuplicate.blobs,
    sources: countsAfterDuplicate.sources,
    sourceVersions: countsAfterDuplicate.sourceVersions,
    occurrences: countsAfterDuplicate.occurrences,
    importItems: countsAfterDuplicate.importItems,
  };
  result.verification = {
    originals: mediaVerification.originals.length,
    posters: mediaVerification.postersDecoded,
    videoPreviews: mediaVerification.videoPreviewsDecoded,
    range: rangeVerification,
    markdownSources: markdownVerification.sources.length,
    browserErrors: 0,
    expectedConflictConsole: consoleMessages.filter((message) => message.text.includes("409 (Conflict)")).length,
  };
  await save("result.json", result);
  writeFileSync(
    join(RUN, "progress.json"),
    `${JSON.stringify({ schemaVersion: 1, stage: "T02b", run: RUN, status: result.status, steps: STEPS }, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.status = "failed";
  result.finishedAt = new Date().toISOString();
  result.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  await save("result.json", result);
  writeFileSync(
    join(RUN, "progress.json"),
    `${JSON.stringify({ schemaVersion: 1, stage: "T02b", run: RUN, status: "failed", steps: STEPS }, null, 2)}\n`,
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  await stopServer();
  serverLog.end();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/health`);
      if (response.ok) return;
    } catch {
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready at ${BASE_URL}`);
}

async function stopServer() {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveDone) => server.once("exit", resolveDone)),
    sleep(5_000),
  ]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveDone) => server.once("exit", resolveDone)),
      sleep(3_000),
    ]);
  }
}

async function apiData(request, method, path, options = {}) {
  const headers = {};
  if (options.csrf !== undefined) headers["x-csrf-token"] = options.csrf;
  if (method !== "GET" && method !== "HEAD") headers["idempotency-key"] = randomUUID();
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await request.fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { data: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const parsed = text === "" ? null : JSON.parse(text);
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()} ${parsed?.error?.code ?? ""} ${parsed?.error?.message ?? text}`);
  }
  return parsed;
}

async function pollJob(request, jobId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await apiData(request, "GET", `/api/v1/jobs/${jobId}`);
    if (["succeeded", "partial", "failed", "cancelled"].includes(job.data.state)) return job.data;
    await sleep(350);
  }
  throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
}

async function waitForVideo(video) {
  await video.evaluate(
    (element) =>
      new Promise((resolveDone, reject) => {
        if (element.readyState >= 1) {
          resolveDone();
          return;
        }
        element.addEventListener("loadedmetadata", resolveDone, { once: true });
        element.addEventListener("error", () => reject(new Error("video load failed")), { once: true });
        setTimeout(() => reject(new Error("video metadata timeout")), 20_000);
      }),
  );
}

async function seekVideo(video) {
  return await video.evaluate(
    (element) =>
      new Promise((resolveDone, reject) => {
        const target = Math.min(1.5, Math.max(0.4, element.duration / 2));
        element.currentTime = target;
        element.addEventListener("seeked", () => resolveDone(element.currentTime), { once: true });
        setTimeout(() => reject(new Error("video seek timeout")), 15_000);
      }),
  );
}

async function verifyOriginalAndDerivatives(request, db, baseline) {
  const baselineByHash = new Map(baseline.localMedia.map((item) => [item.sha256, item]));
  const assets = await apiData(request, "GET", "/api/v1/assets?limit=100");
  const derivativeRows = db
    .prepare("SELECT asset_id, kind, blob_hash FROM derivatives WHERE status = 'ready'")
    .all();
  const derivativesByAsset = new Map();
  for (const row of derivativeRows) {
    const list = derivativesByAsset.get(row.asset_id) ?? [];
    list.push(row);
    derivativesByAsset.set(row.asset_id, list);
  }
  const originals = [];
  let postersDecoded = 0;
  let videoPreviewsDecoded = 0;
  const gifAnimations = [];
  for (const asset of assets.data.items) {
    const hash = hashFromUrl(asset.originalFileUrl);
    const response = await request.get(`${BASE_URL}${asset.originalFileUrl}`);
    ensure(response.ok(), `原件下载失败: ${asset.originalFileUrl}`);
    const bytes = await response.body();
    const actual = sha256(bytes);
    const baselineItem = baselineByHash.get(hash);
    ensure(baselineItem !== undefined, `原件 hash 不在 baseline: ${hash}`);
    ensure(actual === hash, `原件实际 hash 不匹配: ${asset.title}`);
    ensure(bytes.byteLength === baselineItem.bytes, `原件字节数不匹配: ${asset.title}`);
    if (asset.mediaKind === "gif") {
      const metadata = await sharp(bytes, { animated: true, limitInputPixels: false }).metadata();
      gifAnimations.push({ hash, pages: metadata.pages ?? 1, width: metadata.width, height: metadata.height });
    }
    originals.push({
      assetId: asset.id,
      title: asset.title,
      kind: asset.mediaKind,
      hash,
      bytes: bytes.byteLength,
      baselinePath: baselineItem.path,
    });
    const derivatives = derivativesByAsset.get(asset.id) ?? [];
    const poster = derivatives.find((row) => row.kind === "poster");
    ensure(poster !== undefined, `素材没有可解码海报: ${asset.title}`);
    const posterResponse = await request.get(`${BASE_URL}/api/v1/files/${poster.blob_hash}`);
    ensure(posterResponse.ok(), `海报下载失败: ${asset.title}`);
    const posterMeta = await sharp(await posterResponse.body()).metadata();
    ensure((posterMeta.width ?? 0) > 0 && (posterMeta.height ?? 0) > 0, `海报无法解码: ${asset.title}`);
    postersDecoded += 1;
    if (asset.mediaKind === "video") {
      const preview = derivatives.find((row) => row.kind === "video_preview");
      ensure(preview !== undefined, `视频没有预览: ${asset.title}`);
      const previewResponse = await request.get(`${BASE_URL}/api/v1/files/${preview.blob_hash}`);
      ensure(previewResponse.ok(), `视频预览下载失败: ${asset.title}`);
      const previewPath = join(TMP, `${preview.blob_hash}.mp4`);
      await writeFile(previewPath, await previewResponse.body());
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,duration", "-of", "json", previewPath],
          { encoding: "utf8" },
        ),
      );
      ensure(probe.streams?.length === 1, `视频预览无法解码: ${asset.title}`);
      videoPreviewsDecoded += 1;
    }
  }
  return {
    originals,
    postersDecoded,
    videoPreviewsDecoded,
    gifAnimations,
    derivativeRows: derivativeRows.length,
  };
}

async function verifyRange(request, assets) {
  const video = assets.find((item) => item.mediaKind === "video");
  ensure(video !== undefined, "没有视频可用于 Range 验证");
  const url = `${BASE_URL}${video.originalFileUrl}`;
  const full = await request.get(url);
  const fullBytes = await full.body();
  const range = await request.fetch(url, { headers: { Range: "bytes=0-1023" } });
  ensure(range.status() === 206, `Range 状态不是 206: ${range.status()}`);
  const rangeBytes = await range.body();
  ensure(rangeBytes.byteLength === 1024, "Range 长度不是 1024");
  ensure(sha256(rangeBytes) === sha256(fullBytes.subarray(0, 1024)), "Range 字节与原件前缀不一致");
  const etag = range.headers().etag;
  ensure(typeof etag === "string" && etag.length > 2, "响应缺少 ETag");
  const cached = await request.get(url, { headers: { "If-None-Match": etag } });
  ensure(cached.status() === 304, `If-None-Match 状态不是 304: ${cached.status()}`);
  const head = await request.head(url);
  ensure(head.status() === 200, `HEAD 状态不是 200: ${head.status()}`);
  ensure(Number(head.headers()["content-length"]) === fullBytes.byteLength, "HEAD Content-Length 不匹配");
  return {
    assetId: video.id,
    status: range.status(),
    bytes: rangeBytes.byteLength,
    etag,
    ifNoneMatchStatus: cached.status(),
    headStatus: head.status(),
    contentLength: Number(head.headers()["content-length"]),
  };
}

async function verifyMarkdown(request, db) {
  const sources = db
    .prepare("SELECT id, title FROM sources WHERE kind = 'local_markdown' ORDER BY title")
    .all();
  ensure(sources.length === 2, `Markdown 来源数不是 2: ${sources.length}`);
  const contexts = [];
  for (const source of sources) {
    const context = await apiData(request, "GET", `/api/v1/sources/${source.id}`);
    contexts.push({
      id: source.id,
      title: source.title,
      version: context.data.version.fingerprint,
      fileUrl: context.data.version.fileUrl,
      occurrences: context.data.occurrences.length,
    });
  }
  const blockId = db.prepare("SELECT COUNT(*) AS count FROM occurrences WHERE locator_json LIKE '%blockId%'").get().count;
  const resolutions = db
    .prepare("SELECT json_extract(locator_json, '$.resolution') AS resolution, COUNT(*) AS count FROM occurrences GROUP BY resolution")
    .all();
  return { sources: contexts, blockIdCount: blockId, resolutions };
}

async function verifyAssetMap(baseline) {
  const mapPath = join(FIXTURE_ROOT, "docs/asset-map.md");
  const text = await readFile(mapPath, "utf8");
  const rows = [];
  for (const line of text.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/u.exec(line);
    if (match === null) continue;
    const filePath = match[1];
    const use = match[2];
    const media = baseline.localMedia.find((item) => item.path.endsWith(filePath));
    if (media === undefined) continue;
    rows.push({ filePath, use, sha256: media.sha256, baselinePath: media.path });
  }
  ensure(rows.length >= 6, "asset-map 解析出的真实媒体少于 6 条");
  return {
    rows,
    note: "asset-map 的用途只用于核验文件来源；当前资产接口没有用途字段，产品标题仍按文件名或人工值保存。",
  };
}

function dbCounts(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  const importItems = Object.fromEntries(
    db.prepare("SELECT state, COUNT(*) AS count FROM import_items GROUP BY state ORDER BY state")
      .all()
      .map((row) => [row.state, row.count]),
  );
  const media = Object.fromEntries(
    db.prepare("SELECT media_kind, COUNT(*) AS count FROM assets GROUP BY media_kind ORDER BY media_kind")
      .all()
      .map((row) => [row.media_kind, row.count]),
  );
  const occurrencesByStatus = Object.fromEntries(
    db.prepare("SELECT media_status, COUNT(*) AS count FROM occurrences GROUP BY media_status ORDER BY media_status")
      .all()
      .map((row) => [row.media_status, row.count]),
  );
  return {
    assets: count("assets"),
    blobs: count("blobs"),
    sources: count("sources"),
    sourceVersions: count("source_versions"),
    occurrences: count("occurrences"),
    derivatives: count("derivatives"),
    importScans: count("import_scans"),
    importItems: { total: count("import_items"), ...importItems },
    media,
    occurrencesByStatus,
  };
}

async function hashTree(root) {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (entry.isSymbolicLink()) {
        files.push({ path: relative(root, path), type: "symlink", bytes: 0, sha256: null });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      files.push({
        path: relative(root, path),
        type: "file",
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        sha256: hash.digest("hex"),
      });
    }
  };
  await visit(root);
  return {
    root,
    files,
    digest: sha256Text(JSON.stringify(files.map((file) => [file.path, file.bytes, file.sha256]))),
  };
}

async function countFiles(root) {
  let count = 0;
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) count += 1;
    }
  };
  await visit(root);
  return count;
}

function hashFromUrl(url) {
  const match = /\/api\/v1\/files\/([a-f0-9]{64})$/u.exec(url);
  ensure(match !== null, `文件地址没有 hash: ${url}`);
  return match[1];
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function findForbidden(text) {
  const terms = ["SQLite", "worker", "lease", "fencing", "blob", "blockId", "CAS", "ETag", "occurrence"];
  return terms.filter((term) => new RegExp(`(^|[^a-zA-Z])${term}([^a-zA-Z]|$)`, "iu").test(text));
}

function checkMultipartOrder(body) {
  const formStart = body.indexOf("const form = new FormData()");
  const fileIndex = body.indexOf('form.append("file"', formStart);
  const fields = ["relativePath", "declaredBytes", "fileId", "chunkIndex", "chunkCount", "chunkSha256"];
  const positions = fields
    .map((field) => ({ field, index: body.indexOf(`form.append("${field}"`, formStart) }))
    .filter((entry) => entry.index >= 0);
  return {
    ok: formStart >= 0 && fileIndex > formStart && positions.length === fields.length &&
      positions.every((entry) => entry.index < fileIndex),
    formStart,
    fileIndex,
    fields: positions,
  };
}

function summarize(text) {
  return text.replace(/\s+/gu, " ").slice(0, 500);
}

function summarizeMediaVerification(verification) {
  return {
    originals: verification.originals.length,
    posters: verification.postersDecoded,
    videoPreviews: verification.videoPreviewsDecoded,
    gifPages: verification.gifAnimations.map((item) => item.pages),
  };
}

function step(name, status, details = undefined) {
  STEPS.push({ name, status, at: new Date().toISOString(), ...(details === undefined ? {} : { details }) });
  writeFileSync(
    join(RUN, "progress.json"),
    `${JSON.stringify({ schemaVersion: 1, stage: "T02b", run: RUN, status: "running", steps: STEPS }, null, 2)}\n`,
  );
}

async function save(name, value) {
  await writeFile(join(RUN, name), `${JSON.stringify(value, null, 2)}\n`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}
