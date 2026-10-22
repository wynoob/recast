import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import {
  ApiSuccessSchema,
  AssetDetailV2Schema,
  ImportCreateRequestSchema,
  ImportDetailSchema,
  SettingsSchema,
  SourceListSchema,
} from "@dmall/contracts";

const ROOT = process.cwd();
const EVIDENCE_ROOT =
  process.env.DCW_T02C_EVIDENCE ?? join(ROOT, "..", "evidence", "green-boundary");
const RUN = join(EVIDENCE_ROOT, `t02c-${Date.now()}`);
const DATA_ROOT = join(RUN, "data");
const FIXTURES = join(RUN, "fixtures");
const SHOTS = join(RUN, "screenshots");
const PORT = process.env.DCW_T02C_PORT ?? "4462";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REAL_FIXTURE = join(
  ROOT,
  "input",
  "Dmall内容工作台-完整交接包-v1.0",
  "materials",
  "local",
);
const results = {
  schemaVersion: 1,
  surface: "real API and production web build",
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  dataRoot: DATA_ROOT,
  cases: [],
  console: {},
  status: "running",
};
const ImportCreateResponseSchema = z.strictObject({
  importId: z.uuid(),
  jobId: z.uuid(),
  status: z.enum(["queued", "running", "waiting_input", "succeeded", "partial", "failed", "cancelled"]),
});

process.env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(ROOT, ".tools", "ms-playwright");

await mkdir(DATA_ROOT, { recursive: true });
await mkdir(SHOTS, { recursive: true });
await mkdir(FIXTURES, { recursive: true });

const fixturePaths = await createFixtures();
const serverLog = [];
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
server.stdout.on("data", (bytes) => serverLog.push(bytes.toString()));
server.stderr.on("data", (bytes) => serverLog.push(bytes.toString()));

let browser;
let failure = null;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    executablePath: join(
      ROOT,
      ".tools",
      "ms-playwright",
      "chromium-1248",
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ),
  });
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const assetDetailRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && /\/api\/v1\/assets\/[0-9a-f-]{36}$/u.test(url.pathname)) {
      assetDetailRequests.push(url.pathname);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ level: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => consoleMessages.push({ level: "pageerror", text: error.message }));
  results.console.main = consoleMessages;

  const health = await api(context.request, "GET", "/api/v1/health");
  const csrf = health.csrfToken;


  results.serverPid = server.pid;
  results.network = [];
  page.on("response", async response => {
    if (new URL(response.url()).pathname !== "/api/v1/sources") return;
    results.network.push({ url: response.url(), status: response.status(), body: await response.json().catch(() => null) });
  });
  let sourceRequests = 0;
  let navigations = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/v1/sources") sourceRequests += 1;
  });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations += 1; });
  const db = new Database(join(DATA_ROOT, "db", "workbench.sqlite"), { readonly: true });
  const snapshots = [];
  try {
    await run("active-empty-source-list-import-without-reload", async () => {
      await page.goto("/assets");
      await page.getByRole("button", { name: "来源文档", exact: true }).click();
      await expect(page.getByRole("heading", { name: "还没有来源文档" })).toBeVisible();
      const beforeRequests = sourceRequests;
      const beforeNavigations = navigations;
      await openDirectoryImport(page, fixturePaths.title);
      const dialog = page.getByRole("dialog");
      await mappingRow(dialog, "map.md").locator("input").check();
      const created = await submitImport(page, dialog);
      await expect(dialog.getByRole("button", { name: "查看素材", exact: true })).toBeVisible({ timeout: 30000 });
      await expect(page.locator(".source-row")).toHaveCount(1);
      ensure(sourceRequests > beforeRequests, "active sources query did not refetch at terminal before onFinished");
      await dialog.getByRole("button", { name: "查看素材", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const list = SourceListSchema.parse(await api(context.request, "GET", "/api/v1/sources?kind=local_markdown"));
      expect(list.total).toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM sources WHERE kind='local_markdown'").get().n).toBe(1);
      ensure(navigations === beforeNavigations, "source refresh caused a navigation");
      await page.screenshot({ path: join(SHOTS, "empty-source-import-updated.png"), fullPage: true });
      results.firstSource = list.items[0];
      return { importId: created.importId, beforeRequests, afterRequests: sourceRequests, uiRows: 1, apiTotal: list.total, dbCount: 1, reloads: 0 };
    });
    await run("existing-source-current-version-refresh", async () => {
      const old = results.firstSource;
      ensure(old !== undefined, "first source fixture unavailable");
      await writeFile(join(fixturePaths.title, "map.md"), "# Updated title\n\n| File | Use |\n|---|---|\n| poster.png | NEW_VERSION |\n");
      const beforeRequests = sourceRequests;
      const beforeNavigations = navigations;
      await openDirectoryImport(page, fixturePaths.title);
      const dialog = page.getByRole("dialog");
      await mappingRow(dialog, "map.md").locator("input").check();
      const created = await submitImport(page, dialog);
      await expect(dialog.getByRole("button", { name: "查看素材", exact: true })).toBeVisible({ timeout: 30000 });
      const current = SourceListSchema.parse(await api(context.request, "GET", "/api/v1/sources?kind=local_markdown"));
      expect(current.items[0].id).toBe(old.id);
      expect(current.items[0].currentVersionId).not.toBe(old.currentVersionId);
      const beforeClick = sourceRequests;
      ensure(beforeClick > beforeRequests, "existing sources query did not refetch at terminal");
      await dialog.getByRole("button", { name: "查看素材", exact: true }).click();
      const requestPromise = page.waitForRequest(request => new URL(request.url()).pathname === `/api/v1/sources/${old.id}`);
      await page.locator(`[data-source-id="${old.id}"]`).click();
      const requested = new URL((await requestPromise).url());
      expect(requested.searchParams.get("versionId")).toBe(current.items[0].currentVersionId);
      await expect(page.getByRole("region", { name: "来源文档上下文" })).toBeVisible();
      ensure(navigations === beforeNavigations, "version refresh caused a navigation");
      await page.screenshot({ path: join(SHOTS, "current-version-updated.png"), fullPage: true });
      await page.getByRole("button", { name: "关闭来源上下文" }).click();
      return { importId: created.importId, sourceId: old.id, previousVersion: old.currentVersionId, currentVersion: current.items[0].currentVersionId, requestedVersion: requested.searchParams.get("versionId"), beforeRequests, afterRequests: sourceRequests };
    });
    await run("fenced-only-partial-retains-source-and-media", async () => {
      const root = await imageFixture("fence", ["# Example only", "", "````markdown", "```", "| File | Use |", "|---|---|", "| image.png | MUST_STAY_CODE_EXAMPLE |", "````", ""].join("\n"));
      const beforeRequests = sourceRequests;
      await openDirectoryImport(page, root);
      const dialog = page.getByRole("dialog");
      await mappingRow(dialog, "map.md").locator("input").check();
      const created = await submitImport(page, dialog);
      await expect(dialog.getByRole("button", { name: "查看素材", exact: true })).toBeVisible({ timeout: 30000 });
      await expect(dialog.getByText("媒体已导入；说明文档未应用", { exact: false }).first()).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "已导入 2 项", exact: true })).toHaveCount(0);
      const imported = await waitImport(context.request, created.importId);
      expect(imported.status).toBe("partial");
      expect(imported.mapping).toMatchObject({ status: "failed", entryCount: 0, sources: [{ status: "failed", errorCode: "MAPPING_FORMAT_NOT_FOUND" }] });
      expect(imported.counts.committed).toBe(2);
      const observed = await dbSnapshot(created.importId);
      expect(observed.entries).toHaveLength(0);
      expect(observed.sourceSuggestion).toBeNull();
      expect(observed.markdownSourceVersions).toHaveLength(1);
      expect(observed.media).toHaveLength(1);
      expect(observed.media[0].state).toBe("committed");
      expect(observed.markdownSourceVersions[0].state).toBe("committed");
      await expect(page.locator(".source-row")).toHaveCount(2);
      ensure(sourceRequests > beforeRequests, "partial import did not refresh sources");
      await page.screenshot({ path: join(SHOTS, "partial-fence-zero-mappings.png"), fullPage: true });
      await dialog.getByRole("button", { name: "查看素材", exact: true }).click();
      snapshots.push(observed);
      return { import: summarizeImport(imported), ...observed, beforeRequests, afterRequests: sourceRequests };
    });
    await run("ordinary-table-real-api-positive-control", async () => {
      const root = await imageFixture("ordinary", "# Real table\n\n| File | Use |\n|---|---|\n| image.png | REAL_TABLE |\n");
      const imported = await scanAndImport(context.request, csrf, root, ["map.md"]);
      expect(imported.detail.status).toBe("succeeded");
      expect(imported.detail.mapping).toMatchObject({ status: "applied", entryCount: 1, linkedEntryCount: 1 });
      const observed = await dbSnapshot(imported.importId);
      expect(observed.entries).toHaveLength(1);
      expect(observed.sourceSuggestion).toMatchObject({ usageText: "REAL_TABLE", provenance: { lineStart: 5 } });
      snapshots.push(observed);
      return { import: summarizeImport(imported.detail), ...observed };
    });
    await run("tasks-recovery-terminal-refreshes-active-list", async () => {
      const beforeRequests = sourceRequests;
      const beforeRows = await page.locator(".source-row").count();
      const beforeNavigations = navigations;
      const root = await imageFixture("tasks", "# Task recovery\n\n| File | Use |\n|---|---|\n| image.png | TASKS |\n");
      const imported = await scanAndImport(context.request, csrf, root, ["map.md"]);
      expect(await page.locator(".source-row").count()).toBe(beforeRows);
      await page.evaluate(importId => {
        localStorage.setItem("dcw.tasks.v1", JSON.stringify([{ jobId: importId, importId, kind: "import", scanId: null, label: "恢复导入", createdAt: new Date().toISOString() }]));
        window.dispatchEvent(new StorageEvent("storage", { key: "dcw.tasks.v1" }));
      }, imported.importId);
      await page.getByRole("button", { name: "任务", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "恢复导入" })).toBeVisible();
      await expect(page.locator(".source-row")).toHaveCount(beforeRows + 2);
      ensure(sourceRequests > beforeRequests, "Tasks monitor did not refresh sources");
      ensure(navigations === beforeNavigations, "Tasks refresh navigated the page");
      await page.screenshot({ path: join(SHOTS, "tasks-recovery-refreshed-sources.png"), fullPage: true });
      await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
      return { importId: imported.importId, beforeRows, afterRows: await page.locator(".source-row").count(), beforeRequests, afterRequests: sourceRequests, importDrawerUsed: false, onFinishedUsed: false, reloads: 0 };
    });
    await run("source-query-error-recovers-on-terminal", async () => {
      const errorContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 } });
      const errorPage = await errorContext.newPage();
      let attempts = 0;
      let navigations = 0;
      let fail = true;
      errorPage.on("framenavigated", frame => { if (frame === errorPage.mainFrame()) navigations += 1; });
      await errorPage.route("**/api/v1/sources?*", async route => {
        attempts += 1;
        if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "来源读取失败", retryable: true, details: {} }, requestId: "controlled-list-error" }) });
        else await route.continue();
      });
      try {
        await errorPage.goto("/assets");
        await errorPage.getByRole("button", { name: "来源文档", exact: true }).click();
        await expect(errorPage.getByText("来源文档暂时无法读取")).toBeVisible({ timeout: 15000 });
        const beforeRequests = attempts;
        const beforeNavigations = navigations;
        fail = false;
        const root = await imageFixture("error-recovery", "# Error recovery\n\n| File | Use |\n|---|---|\n| image.png | RECOVERED |\n");
        await openDirectoryImport(errorPage, root);
        const dialog = errorPage.getByRole("dialog");
        const created = await submitImport(errorPage, dialog);
        await expect(dialog.getByRole("button", { name: "查看素材", exact: true })).toBeVisible({ timeout: 30000 });
        const current = SourceListSchema.parse(await api(context.request, "GET", "/api/v1/sources?kind=local_markdown"));
        await expect(errorPage.locator(".source-row")).toHaveCount(current.total);
        ensure(attempts > beforeRequests, "errored active query did not refetch on terminal");
        expect(navigations).toBe(beforeNavigations);
        await errorPage.screenshot({ path: join(SHOTS, "error-query-recovered.png"), fullPage: true });
        return { controlledHttp: "initial sources GET 500 only; import and recovered list use real server", importId: created.importId, beforeRequests, afterRequests: attempts, uiRows: current.total, reloads: 0 };
      } finally { await errorContext.close(); }
    });
    await writeFile(join(RUN, "sqlite-snapshots.json"), JSON.stringify(snapshots, null, 2));

  } finally { db.close(); }
  ensure(consoleMessages.length === 0, `Unexpected main-page console errors: ${JSON.stringify(consoleMessages)}`);

  async function imageFixture(name, markdown) {
    const root = join(FIXTURES, name);
    await mkdir(root, { recursive: true });
    await sharp({ create: { width: 33, height: 22 + results.cases.length, channels: 3, background: "#a126ed" } }).png().toFile(join(root, "image.png"));
    await writeFile(join(root, "map.md"), markdown);
    return root;
  }
  async function dbSnapshot(importId) {
    const entries = db.prepare("SELECT * FROM asset_map_entries WHERE import_job_id=?").all(importId);
    const media = db.prepare("SELECT asset_id,state FROM import_items WHERE import_job_id=? AND asset_id IS NOT NULL").all(importId);
    const markdownSourceVersions = db.prepare("SELECT i.state,sv.id,sv.source_id,sv.fingerprint FROM import_items i JOIN source_versions sv ON sv.id=i.source_version_id JOIN sources s ON s.id=sv.source_id WHERE i.import_job_id=? AND s.kind='local_markdown'").all(importId);
    const detail = AssetDetailV2Schema.parse(await api(context.request, "GET", `/api/v1/assets/${media[0].asset_id}`));
    return { importId, entries, media, markdownSourceVersions, sourceSuggestion: detail.sourceSuggestion };
  }
  results.loadedJs = await page.evaluate(() => [...document.scripts].filter(s => s.type === "module").map(s => s.src));
  results.status = results.cases.some(entry => entry.status === "failed") ? "failed" : "passed";
  if (results.status === "failed") throw new Error("One or more product assertions failed");
} catch (error) {
  failure = error;
  results.status = "failed";
  results.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await writeFile(join(RUN, "server.log"), serverLog.join(""), "utf8");
  results.endedAt = new Date().toISOString();
  await writeFile(join(RUN, "result.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await writeFile(
    join(EVIDENCE_ROOT, "t02c-latest.json"),
    `${JSON.stringify({ run: RUN, status: results.status, cases: results.cases.map((entry) => ({ name: entry.name, status: entry.status, durationMs: entry.durationMs })) }, null, 2)}\n`,
    "utf8",
  );
}

if (failure !== null) {
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: results.status, cases: results.cases.length, run: RUN }, null, 2));
}

async function run(name, fn) {
  const filter = process.env.DCW_T02C_CASE_FILTER;
  if (filter !== undefined && !new RegExp(filter, "u").test(name)) return undefined;
  const started = Date.now();
  try {
    const details = await fn();
    results.cases.push({ name, status: "passed", durationMs: Date.now() - started, details });
    console.log(`PASS ${name}`);
    return details;
  } catch (error) {
    results.cases.push({
      name,
      status: "failed",
      durationMs: Date.now() - started,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    });
    console.log(`FAIL ${name}`);
    return undefined;
  }
}

async function createFixtures() {
  const title = join(FIXTURES, "title");
  await mkdir(title, { recursive: true });
  await sharp({ create: { width: 48, height: 32, channels: 3, background: "#7c3aed" } }).png().toFile(join(title, "poster.png"));
  await writeFile(join(title, "map.md"), "# Title Mapping\n\n| File | Use | Title |\n|---|---|---|\n| poster.png | ORIGINAL | 标题预填 |\n");
  return { title };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/health`, { headers: { host: `127.0.0.1:${PORT}` } });
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("T02c server did not become ready");
}

async function api(request, method, path, body, csrf) {
  const headers = {};
  if (method !== "GET") headers["x-csrf-token"] = csrf;
  if (method !== "GET") headers["idempotency-key"] = randomUUID();
  const response = await request.fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { data: body }),
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()} ${JSON.stringify(raw)}`);
  }
  return raw.data;
}

async function scanAndImport(request, csrf, rootPath, mappingPaths = []) {
  const scan = await api(request, "POST", "/api/v1/imports/scan", {
    schemaVersion: 1,
    sourceKind: "local_directory",
    rootPath,
    options: { generatePreviews: true },
  }, csrf);
  let scanDetail = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    scanDetail = await api(request, "GET", `/api/v1/imports/scans/${scan.scanId}`);
    if (scanDetail.status === "ready" || scanDetail.status === "failed" || scanDetail.status === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  ensure(scanDetail?.status === "ready", `扫描没有 ready：${scanDetail?.status}`);
  const page = await request.fetch(`${BASE_URL}/api/v1/imports/scans/${scan.scanId}/items?status=candidate&limit=100`).then((response) => response.json());
  const items = page.data.items;
  const mappingIds = mappingPaths.map((path) => {
    const item = items.find((candidate) => candidate.relativePath === path);
    ensure(item !== undefined, `扫描中找不到映射文件 ${path}`);
    return item.id;
  });
  const created = await api(request, "POST", "/api/v1/imports", {
    schemaVersion: 1,
    scanId: scan.scanId,
    selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
    options: { generatePreviews: true, ocr: "blocked", allowExternalModel: false, allowFeishu: false },
    ...(mappingIds.length === 0 ? {} : { assetMap: { format: "markdown-asset-table/v1", sourceScanItemIds: mappingIds } }),
  }, csrf);
  return { importId: created.importId, detail: await waitImport(request, created.importId) };
}

async function waitImport(request, importId) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const detail = ImportDetailSchema.parse(await api(request, "GET", `/api/v1/imports/${importId}?limit=100`));
    if (["succeeded", "partial", "failed", "cancelled"].includes(detail.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`导入未在时限内结束：${importId}`);
}

async function openDirectoryImport(page, rootPath) {
  await page.getByRole("button", { name: "导入素材", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("本次要扫描的文件夹路径").fill(rootPath);
  await dialog.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "确认导入范围" })).toBeVisible({ timeout: 180_000 });
}

async function submitImport(page, dialog) {
  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/imports");
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/imports");
  await dialog.locator(".confirm-copy input[type=checkbox]").check();
  await dialog.getByRole("button", { name: /确认导入 \d+ 项/u }).click();
  const request = await requestPromise;
  const response = await responsePromise;
  const body = request.postDataJSON();
  ImportCreateRequestSchema.parse(body);
  const raw = await response.json();
  const created = ApiSuccessSchema(ImportCreateResponseSchema).parse(raw).data;
  return { importId: created.importId, body, requestBody: body };
}

function mappingRow(dialog, path) {
  return dialog.locator(`[data-testid^="mapping-choice-"][data-path="${path}"]`);
}

function candidateRow(dialog, path) {
  return dialog.locator(`[data-testid^="candidate-"][data-path="${path}"]`);
}

function closeDialogButton(dialog) {
  return dialog.locator("button.button", { hasText: "关闭" }).last();
}

function closeDialogIcon(dialog) {
  return dialog.locator('button[aria-label="关闭"]').first();
}

function summarizeImport(detail) {
  return {
    importId: detail.importId,
    status: detail.status,
    counts: detail.counts,
    mapping: detail.mapping,
  };
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
