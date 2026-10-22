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
  process.env.DCW_T02C_EVIDENCE ??
  "/Users/wangyun/Projects/AI-Harness/agent-evidence/dmall-content-workbench/recast-20261021/integration/t02c-final/evidence";
const RUN = join(EVIDENCE_ROOT, `t02c-${Date.now()}`);
const DATA_ROOT = join(RUN, "data");
const FIXTURES = join(RUN, "fixtures");
const SHOTS = join(RUN, "screenshots");
const PORT = process.env.DCW_T02C_PORT ?? "4347";
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

  await run("empty-source-list", async () => {
    await page.goto("/assets");
    await expect(page.getByRole("heading", { name: "素材库为空" })).toBeVisible();
    await page.getByRole("button", { name: "来源文档", exact: true }).click();
    await expect(page.getByRole("heading", { name: "还没有来源文档" })).toBeVisible();
  });

  const realImport = await run("real-mapping-and-mapping-ui", async () => {
    await page.goto("/assets");
    await openDirectoryImport(page, REAL_FIXTURE);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "确认导入范围" })).toBeVisible();
    await expect(dialog.locator('[data-testid^="mapping-choice-"]')).toHaveCount(2);
    expect(await dialog.locator('[data-testid^="mapping-choice-"] input[type=checkbox]:checked').count()).toBe(0);
    await mappingRow(dialog, "docs/asset-map.md").locator("input").check();
    await expect(dialog.getByText("1 / 3")).toBeVisible();
    for (const width of [1280, 728, 360]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await page.screenshot({ path: join(SHOTS, `import-confirm-mapping-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const created = await submitImport(page, dialog);
    expect(created.body.assetMap).toEqual({
      format: "markdown-asset-table/v1",
      sourceScanItemIds: [created.body.assetMap.sourceScanItemIds[0]],
    });
    await expect(dialog.getByText("映射已应用 13 条，已关联 13 个素材")).toBeVisible({ timeout: 300_000 });
    await expect(dialog.getByRole("button", { name: "查看素材" })).toBeVisible({ timeout: 300_000 });
    const detail = await waitImport(context.request, created.importId);
    ensure(detail.status === "succeeded", `真实导入状态应为 succeeded，实际 ${detail.status}`);
    ensure(detail.counts.total === 26 && detail.counts.committed === 26, `真实导入计数不符：${JSON.stringify(detail.counts)}`);
    ensure(detail.mapping?.status === "applied", "真实映射没有应用");
    ensure(detail.mapping.entryCount === 13, `真实映射应为 13 条，实际 ${detail.mapping.entryCount}`);
    ensure(detail.mapping.linkedEntryCount === 13, `真实映射应关联 13 个素材，实际 ${detail.mapping.linkedEntryCount}`);
    await page.getByRole("button", { name: "查看素材" }).click();
    await expect(page.getByText("共 24 项", { exact: false })).toBeVisible({ timeout: 60_000 });
    return { importId: created.importId, request: created.body, detail: summarizeImport(detail) };
  });

  await run("source-list-real-rows-and-navigation", async () => {
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.getByRole("button", { name: "来源文档", exact: true }).click();
    await expect(page.locator(".source-row")).toHaveCount(2, { timeout: 30_000 });
    const rows = await page.locator(".source-row").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-source-id"),
        text: node.textContent ?? "",
      })),
    );
    ensure(rows.every((row) => row.id !== null), "来源行缺少 sourceId");
    ensure(rows.every((row) => row.text.includes("本地 Markdown")), "来源行没有真实 Markdown 标签");
    ensure(!rows.some((row) => row.text.includes("个来源 ·")), "来源列表仍混入素材卡计数");
    const assetDetailRequests = requests.filter((url) => /\/api\/v1\/assets\/[0-9a-f-]{36}$/u.test(new URL(url).pathname));
    ensure(assetDetailRequests.length === 0, `来源列表出现素材详情请求：${assetDetailRequests.join(",")}`);
    await page.locator(".source-row").first().click();
    const overlay = page.getByRole("region", { name: "来源文档上下文" });
    await expect(overlay).toBeVisible();
    const sourceRequests = requests.filter((url) => /\/api\/v1\/sources\/[0-9a-f-]{36}/u.test(new URL(url).pathname));
    ensure(sourceRequests.length === 1, `来源行应只发一次 source 请求，实际 ${sourceRequests.length}`);
    ensure(sourceRequests[0].includes("versionId="), "来源行没有带 currentVersionId");
    await overlay.getByRole("button", { name: "关闭来源上下文" }).click();
    await expect(overlay).toHaveCount(0);
    return { rows, sourceRequests };
  });

  await run("poster-origins-and-video-detail", async () => {
    await page.getByRole("button", { name: "全部", exact: true }).click();
    const assets = await api(context.request, "GET", "/api/v1/assets?limit=100");
    const video = assets.items.find((item) => item.mediaKind === "video");
    ensure(video !== undefined, "真实导入没有视频素材");
    ensure(video.posterFileUrl !== null, "视频素材没有 posterFileUrl");
    const card = page.locator(`.asset-card[data-asset-id="${video.id}"]`);
    await card.waitFor({ timeout: 30_000 });
    ensure(assetDetailRequests.length === 0, `素材卡加载触发了详情请求：${assetDetailRequests.join(",")}`);
    const image = card.locator("img");
    await expect(image).toHaveAttribute("src", video.posterFileUrl);
    expect(await card.locator("video").count()).toBe(0);
    await expect(card.locator(".asset-origin")).toHaveText("来源值");
    const posterResponse = await context.request.get(`${BASE_URL}${video.posterFileUrl}`);
    ensure(posterResponse.ok(), `poster 下载失败：${posterResponse.status()}`);
    const posterBytes = await posterResponse.body();
    const metadata = await sharp(posterBytes).metadata();
    ensure(metadata.format === "webp", `poster 解码格式应为 webp，实际 ${metadata.format}`);
    await card.click();
    const dialog = page.getByRole("dialog");
    const videoElement = dialog.locator("video[data-testid=asset-video]");
    await expect(videoElement).toHaveAttribute("poster", video.posterFileUrl);
    await expect(videoElement).toHaveAttribute("src", video.originalFileUrl);
    await page.screenshot({ path: join(SHOTS, "asset-video-detail-1280.png"), fullPage: true });
    await closeDialogButton(dialog).click();
    return { videoId: video.id, posterBytes: posterBytes.byteLength, posterFormat: metadata.format };
  });

  const suggestion = await run("source-suggestion-title-fallback-and-manual-precedence", async () => {
    const assets = await api(context.request, "GET", "/api/v1/assets?limit=100");
    let candidate = null;
    for (const item of assets.items) {
      const detail = AssetDetailV2Schema.parse(await api(context.request, "GET", `/api/v1/assets/${item.id}`));
      if (detail.sourceSuggestion !== null) {
        candidate = detail;
        break;
      }
    }
    ensure(candidate !== null, "真实导入后找不到 sourceSuggestion");
    const asset = candidate.summary;
    const sourceSuggestion = candidate.sourceSuggestion;
    ensure(sourceSuggestion !== null, "sourceSuggestion 为空");
    ensure(sourceSuggestion.title === null, "真实 asset-map 行不应有 Title");
    await page.goto("/assets");
    await page.getByPlaceholder("搜索标题或标签").fill(asset.title);
    const card = page.locator(`.asset-card[data-asset-id="${asset.id}"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.click();
    const dialog = page.getByRole("dialog");
    const titleInput = dialog.getByLabel(/^标题/);
    await expect(titleInput).toHaveValue(asset.title);
    await expect(dialog.getByText("说明文档没有标题，继续使用文件名。")).toBeVisible();
    ensure((await dialog.locator(".usage-text").textContent()) === sourceSuggestion.usageText, "建议 usageText 没有完整展示");
    await expect(dialog.locator(".suggestion-source")).toContainText(sourceSuggestion.provenance.fileCell);
    await expect(dialog.locator(".suggestion-source")).toContainText(sourceSuggestion.provenance.sourceVersionId.slice(0, 12));
    await dialog.getByRole("button", { name: "查看原文" }).click();
    ensure((await dialog.locator("pre.usage-raw").textContent()) === sourceSuggestion.usageMarkdown, "查看原文没有逐字展示 usageMarkdown");
    await dialog.getByRole("button", { name: "打开来源" }).click();
    await expect(dialog.getByRole("region", { name: "来源文档上下文" })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭来源上下文" }).click();
    for (const width of [1280, 728, 360]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await page.screenshot({ path: join(SHOTS, `asset-suggestion-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const manualTitle = `人工标题 ${Date.now()}`;
    await titleInput.fill(manualTitle);
    await dialog.getByRole("button", { name: "保存修改" }).click();
    await expect(dialog.getByText(/已保存为新版本/)).toBeVisible({ timeout: 30_000 });
    await closeDialogButton(dialog).click();
    await page.getByPlaceholder("搜索标题或标签").fill(manualTitle);
    const updatedCard = page.locator(`.asset-card[data-asset-id="${asset.id}"]`);
    await updatedCard.waitFor({ timeout: 30_000 });
    await expect(updatedCard.locator(".asset-origin")).toHaveText("含人工值");
    await updatedCard.click();
    await expect(page.getByRole("dialog").getByLabel(/^标题/)).toHaveValue(manualTitle);
    await expect(page.getByRole("dialog").getByText("说明文档没有标题，继续使用文件名。")).toHaveCount(0);
    await closeDialogButton(page.getByRole("dialog")).click();
    return {
      assetId: asset.id,
      manualTitle,
      usageTextLength: [...sourceSuggestion.usageText].length,
      usageMarkdownLength: [...sourceSuggestion.usageMarkdown].length,
      fileCell: sourceSuggestion.provenance.fileCell,
      lineStart: sourceSuggestion.provenance.lineStart,
      lineEnd: sourceSuggestion.provenance.lineEnd,
    };
  });

  await run("mapping-batch-13-rows-fixed-version", async () => {
    const assets = await api(context.request, "GET", "/api/v1/assets?limit=100");
    const details = [];
    for (const asset of assets.items) {
      const detail = AssetDetailV2Schema.parse(await api(context.request, "GET", `/api/v1/assets/${asset.id}`));
      if (detail.sourceSuggestion !== null) details.push(detail);
    }
    ensure(details.length === 13, `应得到 13 个带建议素材，实际 ${details.length}`);
    const versions = new Set(details.map((detail) => detail.sourceSuggestion?.provenance.sourceVersionId));
    ensure(versions.size === 1, `13 行没有固定同一 sourceVersion，实际 ${versions.size}`);
    ensure(details.every((detail) => detail.sourceSuggestion?.title === null), "真实映射出现了非空 Title");
    ensure(
      details.some((detail) => detail.sourceSuggestion?.usageText.includes("Official Dmall logo")),
      "真实映射没有保留品牌行完整说明",
    );
    return {
      suggestions: details.length,
      sourceVersionId: [...versions][0],
      lines: details.map((detail) => `${detail.sourceSuggestion?.provenance.lineStart}-${detail.sourceSuggestion?.provenance.lineEnd}`),
    };
  });

  await run("title-prefill-and-manual-save", async () => {
    const seeded = await scanAndImport(context.request, csrf, fixturePaths.title, ["map.md"]);
    ensure(seeded.detail.mapping?.status === "applied", "Title fixture 映射未应用");
    await page.goto("/assets");
    const assets = await api(context.request, "GET", "/api/v1/assets?limit=100");
    let candidate = null;
    for (const item of assets.items) {
      const detail = AssetDetailV2Schema.parse(await api(context.request, "GET", `/api/v1/assets/${item.id}`));
      if (detail.sourceSuggestion?.title === "标题预填") {
        candidate = detail;
        break;
      }
    }
    ensure(candidate !== null, "找不到标题预填建议");
    await page.getByPlaceholder("搜索标题或标签").fill(candidate.summary.title);
    const card = page.locator(`.asset-card[data-asset-id="${candidate.summary.id}"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.click();
    const dialog = page.getByRole("dialog");
    const titleInput = dialog.getByLabel(/^标题/);
    await expect(titleInput).toHaveValue("标题预填");
    await expect(dialog.getByText("说明文档提供了标题，已预填。保存后才会采用。")).toBeVisible();
    await titleInput.fill("人工标题保留");
    await dialog.getByRole("button", { name: "保存修改" }).click();
    await expect(dialog.getByText(/已保存为新版本/)).toBeVisible({ timeout: 30_000 });
    await closeDialogButton(dialog).click();
    await page.reload();
    await page.getByPlaceholder("搜索标题或标签").fill("人工标题保留");
    const updated = page.locator(`.asset-card[data-asset-id="${candidate.summary.id}"]`);
    await updated.waitFor({ timeout: 30_000 });
    await updated.click();
    await expect(page.getByRole("dialog").getByLabel(/^标题/)).toHaveValue("人工标题保留");
    await closeDialogButton(page.getByRole("dialog")).click();
    return { assetId: candidate.summary.id };
  });

  await run("mapping-order-and-prune", async () => {
    await page.goto("/assets");
    await openDirectoryImport(page, fixturePaths.order);
    const orderDialog = page.getByRole("dialog");
    await expect(orderDialog.locator('[data-testid^="mapping-choice-"]')).toHaveCount(4);
    await mappingRow(orderDialog, "a.md").locator("input").check();
    await mappingRow(orderDialog, "b.md").locator("input").check();
    await mappingRow(orderDialog, "c.md").locator("input").check();
    await expect(mappingRow(orderDialog, "d.md").locator("input")).toBeDisabled();
    await orderDialog.getByRole("button", { name: "上移 b.md" }).click();
    const ordered = await orderDialog.locator('[data-testid="mapping-selected"]').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-path")),
    );
    expect(ordered).toEqual(["b.md", "a.md", "c.md"]);
    const first = await submitImport(page, orderDialog);
    expect(first.requestBody.assetMap.sourceScanItemIds).toHaveLength(3);
    await expect(orderDialog.getByText("映射已应用 3 条，已关联 1 个素材")).toBeVisible({ timeout: 120_000 });
    await closeDialogIcon(orderDialog).click();

    await page.goto("/assets");
    await openDirectoryImport(page, fixturePaths.order);
    const pruneDialog = page.getByRole("dialog");
    await mappingRow(pruneDialog, "a.md").locator("input").check();
    await mappingRow(pruneDialog, "b.md").locator("input").check();
    await candidateRow(pruneDialog, "a.md").locator("input").uncheck();
    const pruned = await pruneDialog.locator('[data-testid="mapping-selected"]').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-path")),
    );
    expect(pruned).toEqual(["b.md"]);
    const second = await submitImport(page, pruneDialog);
    expect(second.requestBody.assetMap.sourceScanItemIds).toHaveLength(1);
    await expect(pruneDialog.getByText("映射已应用 1 条，已关联 1 个素材")).toBeVisible({ timeout: 120_000 });
    await closeDialogIcon(pruneDialog).click();
    return { ordered, pruned, first: first.requestBody.assetMap, second: second.requestBody.assetMap };
  });

  await run("upload-path-mapping", async () => {
    await page.goto("/assets");
    await page.getByRole("button", { name: "导入素材", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "上传文件或目录" }).click();
    await dialog.getByTestId("upload-files").setInputFiles([
      join(fixturePaths.upload, "upload.png"),
      join(fixturePaths.upload, "map.md"),
    ]);
    await dialog.getByRole("button", { name: "上传并扫描" }).click();
    await expect(dialog.getByRole("heading", { name: "确认导入范围" })).toBeVisible({ timeout: 120_000 });
    await mappingRow(dialog, "map.md").locator("input").check();
    const created = await submitImport(page, dialog);
    expect(created.requestBody.assetMap).toEqual({
      format: "markdown-asset-table/v1",
      sourceScanItemIds: [created.requestBody.assetMap.sourceScanItemIds[0]],
    });
    await expect(dialog.getByText("映射已应用 1 条，已关联 1 个素材")).toBeVisible({ timeout: 120_000 });
    await closeDialogIcon(dialog).click();
    const detail = await waitImport(context.request, created.importId);
    ensure(detail.mapping?.status === "applied" && detail.mapping.entryCount === 1, "上传路径映射没有应用");
    return { importId: created.importId, request: created.requestBody };
  });

  await run("partial-mapping-failure-copy", async () => {
    await page.goto("/assets");
    await openDirectoryImport(page, fixturePaths.partial);
    const dialog = page.getByRole("dialog");
    await mappingRow(dialog, "notes.md").locator("input").check();
    const created = await submitImport(page, dialog);
    await expect(dialog.getByText("媒体已导入；说明文档未应用").first()).toBeVisible({ timeout: 120_000 });
    await expect(dialog.locator(".notice.success")).toHaveCount(0);
    await expect(dialog.getByText("已导入 2 项")).toHaveCount(0);
    const detail = await waitImport(context.request, created.importId);
    ensure(detail.status === "partial", `映射失败任务应为 partial，实际 ${detail.status}`);
    ensure(detail.mapping?.status === "failed", `映射状态应为 failed，实际 ${detail.mapping?.status}`);
    ensure(detail.mapping.entryCount === 0, `映射失败必须零 entries，实际 ${detail.mapping.entryCount}`);
    ensure(detail.counts.committed >= 1, "映射失败时媒体没有保留");
    await page.screenshot({ path: join(SHOTS, "import-partial-mapping-1280.png"), fullPage: true });
    await closeDialogIcon(dialog).click();
    return { importId: created.importId, detail: summarizeImport(detail) };
  });

  await run("source-pagination-and-responsive", async () => {
    const seeded = await scanAndImport(context.request, csrf, fixturePaths.sources);
    ensure(seeded.detail.status === "succeeded", `来源分页 fixture 导入失败：${seeded.detail.status}`);
    await page.goto("/assets");
    await page.getByRole("button", { name: "来源文档", exact: true }).click();
    await expect(page.locator(".source-row")).toHaveCount(20, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
    const firstPage = await page.locator(".source-row").count();
    for (const width of [1280, 728, 360]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await page.screenshot({ path: join(SHOTS, `source-list-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.locator(".source-row").first()).toBeVisible();
    const secondPage = await page.locator(".source-row").count();
    ensure(secondPage > 0, "来源第二页没有内容");
    return { firstPage, secondPage, importId: seeded.importId };
  });

  await run("settings-real-actions", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/assets");
    await page.getByRole("button", { name: "设置" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("扫描文件夹与导入本地副本")).toBeVisible();
    await expect(dialog.locator(".status-row", { hasText: "扫描文件夹与导入本地副本" }).getByText("可用", { exact: true })).toBeVisible();
    await expect(dialog.getByText("编辑素材标题与标签")).toBeVisible();
    await expect(dialog.getByText("未开放", { exact: true }).first()).toBeVisible();
    const text = await dialog.innerText();
    assertNoEngineeringCopy(text);
    await page.screenshot({ path: join(SHOTS, "settings-actions-1280.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await run("source-empty-error-no-version", async () => {
    await mockSourceStates(browser);
  });

  await run("settings-three-api-states", async () => {
    const settings = SettingsSchema.parse(await api(context.request, "GET", "/api/v1/settings"));
    for (const [state, expected] of [
      ["implemented_pending_acceptance", "可用"],
      ["available_t02", "可用"],
      ["not_implemented_t02", "当前版本不支持本地导入"],
    ]) {
      const stateContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 } });
      const statePage = await stateContext.newPage();
      await statePage.route("**/api/v1/settings", async (route) => {
        const payload = {
          data: { ...settings, features: { ...settings.features, localImport: state } },
          requestId: "t02c-settings",
        };
        SettingsSchema.parse(payload.data);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      });
      await statePage.goto("/assets");
      await statePage.getByRole("button", { name: "设置" }).click();
      const dialog = statePage.getByRole("dialog");
      await expect(dialog.getByText("扫描文件夹与导入本地副本")).toBeVisible();
      await expect(dialog.getByText(expected, { exact: true }).first()).toBeVisible();
      assertNoEngineeringCopy(await dialog.innerText());
      await stateContext.close();
    }
  });

  const consoleErrors = consoleMessages.filter((message) => message.level === "error" || message.level === "pageerror");
  results.console.mainErrorCount = consoleErrors.length;
  ensure(consoleErrors.length === 0, `主流程 console 有错误：${JSON.stringify(consoleErrors)}`);

  results.status = "passed";
  results.realImport = realImport;
  results.suggestion = suggestion;
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
    throw error;
  }
}

async function createFixtures() {
  const title = join(FIXTURES, "title");
  const partial = join(FIXTURES, "partial");
  const order = join(FIXTURES, "order");
  const upload = join(FIXTURES, "upload");
  const sources = join(FIXTURES, "sources");
  for (const path of [title, partial, order, upload, sources]) await mkdir(path, { recursive: true });

  const colors = [
    { r: 124, g: 58, b: 237 },
    { r: 20, g: 170, b: 150 },
    { r: 230, g: 140, b: 60 },
    { r: 40, g: 120, b: 220 },
  ];
  let index = 0;
  const makePng = async (path) => {
    const color = colors[index++ % colors.length];
    await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).png().toFile(path);
  };

  await makePng(join(title, "poster.png"));
  await writeFile(
    join(title, "map.md"),
    "# Title Mapping\n\n| File | Use | Title |\n|---|---|---|\n| `poster.png` | 展示标题预填与人工优先。 | 标题预填 |\n",
    "utf8",
  );

  await makePng(join(partial, "image.png"));
  await writeFile(join(partial, "notes.md"), "# Notes\n\n没有 File 与 Use 表格。\n", "utf8");

  await makePng(join(order, "image.png"));
  for (const [name, use] of [
    ["a.md", "顺序 A 说明。"],
    ["b.md", "顺序 B 说明。"],
    ["c.md", "顺序 C 说明。"],
    ["d.md", "顺序 D 说明。"],
  ]) {
    await writeFile(
      join(order, name),
      `# ${name}\n\n| File | Use |\n|---|---|\n| \`image.png\` | ${use} |\n`,
      "utf8",
    );
  }

  await makePng(join(upload, "upload.png"));
  await writeFile(
    join(upload, "map.md"),
    "# Upload Mapping\n\n| File | Use | Title |\n|---|---|---|\n| `upload.png` | 上传路径映射说明。 | 上传标题 |\n",
    "utf8",
  );

  await makePng(join(sources, "image.png"));
  for (let number = 1; number <= 21; number += 1) {
    await writeFile(
      join(sources, `source-${String(number).padStart(2, "0")}.md`),
      `# Source ${number}\n\n| File | Use |\n|---|---|\n| \`image.png\` | 来源 ${number} 的说明。 |\n`,
      "utf8",
    );
  }

  return { title, partial, order, upload, sources };
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

async function mockSourceStates(browserInstance) {
  const source = {
    id: randomUUID(),
    kind: "local_markdown",
    title: "没有版本的旧来源",
    status: "active",
    currentVersionId: null,
    occurrenceCount: 0,
    missingOccurrenceCount: 0,
    linkedAssetCount: 0,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };

  const emptyContext = await browserInstance.newContext({ baseURL: BASE_URL });
  const emptyPage = await emptyContext.newPage();
  await emptyPage.route("**/api/v1/sources?*", async (route) => {
    const payload = { data: SourceListSchema.parse({ items: [], nextCursor: null, total: 0 }), requestId: "t02c-empty" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await emptyPage.goto("/assets");
  await emptyPage.getByRole("button", { name: "来源文档", exact: true }).click();
  await expect(emptyPage.getByRole("heading", { name: "还没有来源文档" })).toBeVisible();
  await emptyContext.close();

  const noVersionContext = await browserInstance.newContext({ baseURL: BASE_URL });
  const noVersionPage = await noVersionContext.newPage();
  const requests = [];
  noVersionPage.on("request", (entry) => requests.push(entry.url()));
  await noVersionPage.route("**/api/v1/sources?*", async (route) => {
    const payload = { data: SourceListSchema.parse({ items: [source], nextCursor: null, total: 1 }), requestId: "t02c-noversion" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await noVersionPage.goto("/assets");
  await noVersionPage.getByRole("button", { name: "来源文档", exact: true }).click();
  await expect(noVersionPage.locator(".source-row")).toHaveCount(1);
  await noVersionPage.locator(".source-row").click();
  await expect(noVersionPage.getByText("该来源没有可打开的版本")).toBeVisible();
  await noVersionPage.waitForTimeout(300);
  ensure(
    requests.filter((url) => new URL(url).pathname === `/api/v1/sources/${source.id}`).length === 0,
    "没有 currentVersionId 时仍请求了来源详情",
  );
  await noVersionContext.close();

  const errorContext = await browserInstance.newContext({ baseURL: BASE_URL });
  const errorPage = await errorContext.newPage();
  let attempts = 0;
  await errorPage.route("**/api/v1/sources?*", async (route) => {
    attempts += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "来源读取失败", retryable: true, details: {} }, requestId: "t02c-error" }),
    });
  });
  await errorPage.goto("/assets");
  await errorPage.getByRole("button", { name: "来源文档", exact: true }).click();
  await expect(errorPage.getByText("来源文档暂时无法读取")).toBeVisible();
  await errorPage.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
  await errorContext.close();
}

function assertNoEngineeringCopy(text) {
  const forbidden = [
    "not_implemented_t02",
    "implemented_pending_acceptance",
    "available_t02",
    "最终验收",
    "评审队列",
    "后端接口缺项",
    "证据目录",
    "测试数量",
    "T02 验收",
  ];
  for (const term of forbidden) ensure(!text.includes(term), `设置界面出现工程文案：${term}`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
