import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { unzipFiles } from "@dmall/renderers";
import { AstSchema } from "@dmall/contracts";
import { createApp, type AppContext } from "../../apps/server/src/app.js";
import type { RuntimeConfig } from "../../apps/server/src/config.js";
import {
  USER_FLOW_CLOSING,
  USER_FLOW_CREDENTIAL_ENV,
  USER_FLOW_IDEA,
  USER_FLOW_IMAGE_TITLE,
  USER_FLOW_PARAGRAPH,
  USER_FLOW_SOURCE_TITLE,
  seedUserFlowFixture,
  startUserFlowProvider,
  type UserFlowProvider,
  type UserFlowSeed,
} from "./fixtures/composer-user-flow.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const apps: AppContext[] = [];
const browsers: Browser[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
  for (const app of apps.splice(0)) await app.app.close();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Composer HTML user flow", () => {
  it("goes from idea and one adjustment through real background delivery to a verified offline deck", async () => {
    const distWeb = join(root, "dist", "web", "index.html");
    const distWorker = join(root, "dist", "apps", "worker", "main.js");
    if (!existsSync(distWeb) || !existsSync(distWorker)) {
      throw new Error("缺少本分支构建产物，先运行 pnpm build 生成 dist/web 和 dist/apps/worker");
    }
    const merchantId = randomUUID();
    const provider = await startUserFlowProvider({ merchantId });
    let seed: UserFlowSeed | null = null;
    const previousEntry = process.env["DCW_WORKER_ENTRY"];
    const previousCredential = process.env[USER_FLOW_CREDENTIAL_ENV];
    process.env["DCW_WORKER_ENTRY"] = distWorker;
    process.env[USER_FLOW_CREDENTIAL_ENV] = "fixture-only";
    try {
      const app = await startWorkflowApp();
      apps.push(app.context);
      seed = await seedUserFlowFixture({ db: app.context.database.db, dataRoot: app.config.dataRoot,
        index: app.context.index, providerBaseUrl: provider.baseUrl, merchantId });
      const browser = await chromium.launch({ headless: true });
      browsers.push(browser);
      const context = await browser.newContext({ acceptDownloads: true });
      const requests = observeRequests(context);
      const page = await context.newPage();

      await page.goto(`${app.base}/compose`);
      const idea = page.locator("textarea[placeholder^='为谁写']");
      await waitForEnabled(idea, 20_000);
      await idea.fill(USER_FLOW_IDEA);
      await page.getByRole("radio", { name: /HTML 演示/ }).check();
      await page.getByRole("button", { name: "生成创作方案" }).click();
      await expect.poll(() => page.url(), { timeout: 20_000 }).toMatch(/\/contents\/[0-9a-f-]{36}$/);
      const contentId = z.uuid().parse(page.url().split("/").at(-1));
      try {
        await waitForVisible(page.getByRole("heading", { name: "库存三步核对", level: 2 }), 30_000);
      } catch (error) {
        throw new Error(`方案未出现：${JSON.stringify(await app.context.composer.read(contentId))}\n`
          + `provider=${JSON.stringify(provider.calls.map((call) => call.phase))} seen=${provider.seenRequests}\n`
          + `configs=${JSON.stringify(app.context.database.db.prepare("SELECT role, base_url, model_id, keychain_ref FROM provider_configs").all())}\n`
          + `jobs=${JSON.stringify(app.context.database.db.prepare("SELECT input_json FROM jobs WHERE type = 'composition_provider'").all())}\n`
          + `calls=${JSON.stringify(app.context.database.db.prepare("SELECT state, error_code, response_hash FROM provider_calls").all())}\n`
          + `payloads=${JSON.stringify(app.context.database.db.prepare("SELECT raw_response FROM provider_call_payloads").all()).slice(0, 3000)}\n`
          + (await page.locator("body").innerText()));
      }
      await waitForVisible(page.getByRole("heading", { name: "页面与图片安排" }));
      await waitForVisible(page.getByText(USER_FLOW_SOURCE_TITLE, { exact: false }).first());
      await waitForVisible(page.getByText(USER_FLOW_IMAGE_TITLE, { exact: false }).first());
      await expect.poll(() => provider.count()).toBe(2);

      await page.getByRole("textbox", { name: "补充或调整要求" }).fill("补充：加入店长每日复盘");
      await page.getByRole("button", { name: "按调整重新规划" }).click();
      await expect.poll(() => page.getByRole("textbox", { name: "补充或调整要求" }).inputValue(), { timeout: 30_000 }).toBe("");
      await waitForVisible(page.getByRole("heading", { name: "库存三步核对", level: 2 }));
      await expect.poll(() => provider.count()).toBe(4);
      expect(provider.calls.filter((call) => call.phase === "intent").map((call) => JSON.stringify(call.payload)))
        .toEqual(expect.arrayContaining([expect.stringContaining("加入店长每日复盘")]));

      await page.getByRole("button", { name: "确认方案并生成成品" }).click();
      await expect.poll(() => count(app, "authoring_confirmations"), { timeout: 20_000 }).toBe(1);

      // Leave the page while the worker continues, then reopen the same content.
      await page.goto(`${app.base}/templates`);
      await expect.poll(() => page.url()).toMatch(/\/templates$/);
      await page.goto(`${app.base}/contents/${contentId}`);
      const deliveredHeading = page.getByRole("heading", { name: "成品已准备好" });
      const blockedHeading = page.getByRole("heading", { name: "创作暂时停在这里" });
      await expect.poll(async () => await deliveredHeading.count() + await blockedHeading.count() > 0, { timeout: 90_000 }).toBe(true);
      if (await deliveredHeading.count() === 0) {
        throw new Error(`成品未交付：${JSON.stringify(await app.context.composer.read(contentId))}\n`
          + `provider=${JSON.stringify(provider.calls.map((call) => call.phase))} seen=${provider.seenRequests}\n`
          + `jobs=${JSON.stringify(app.context.database.db.prepare("SELECT type, state, phase, substr(COALESCE(error_json, ''), 1, 600) AS error FROM jobs ORDER BY created_at").all())}\n`
          + (await page.locator("body").innerText()));
      }
      await waitForVisible(deliveredHeading);
      const evidenceDir = process.env["DCW_EVIDENCE_DIR"];
      if (evidenceDir !== undefined) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: join(evidenceDir, "composer-user-flow-delivered.png"), fullPage: true });
      }

      const previewUrl = new URL(z.string().parse(await page.locator("iframe[title='HTML 演示成品预览']").getAttribute("src")), page.url()).href;
      const frame = page.frameLocator("iframe[title='HTML 演示成品预览']");
      await expectText(frame.locator(".slide.is-active"), USER_FLOW_PARAGRAPH, 30_000);
      expect(await frame.locator(".slide").count()).toBe(2);
      const image = frame.locator(".slide.is-active img").first();
      await waitForVisible(image);
      await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement ? element.naturalWidth : 0))
        .toBeGreaterThan(0);
      const imageSrc = z.string().parse(await image.getAttribute("src"));
      const previewImage = await page.request.get(new URL(imageSrc, previewUrl).href);
      expect(previewImage.status()).toBe(200);
      expect(sha256(await previewImage.body())).toBe(seed.imageSha256);
      await frame.locator("[data-next]").click();
      await expectText(frame.locator(".slide.is-active"), "今日执行");
      await expectText(frame.locator(".slide.is-active"), USER_FLOW_CLOSING);
      await frame.locator("[data-prev]").click();
      await expectText(frame.locator(".slide.is-active"), USER_FLOW_PARAGRAPH);

      const downloadEvent = page.waitForEvent("download");
      await page.getByRole("link", { name: "下载 ZIP" }).click();
      const download = await downloadEvent;
      const work = await mkdtemp(join(tmpdir(), "dcw-composer-flow-"));
      temporary.push(work);
      const zipPath = join(work, "deck.zip");
      await download.saveAs(zipPath);
      const zipBytes = await readFile(zipPath);
      const artifact = z.strictObject({ sha256: z.string() }).parse(
        app.context.database.db.prepare("SELECT sha256 FROM export_artifacts WHERE kind = 'html_zip'").get());
      expect(sha256(zipBytes)).toBe(artifact.sha256);
      const zip = unzipFiles(zipBytes);
      const indexHtml = Buffer.from(zip["index.html"] ?? []).toString("utf8");
      expect(indexHtml).toContain(USER_FLOW_PARAGRAPH);
      expect(indexHtml).toContain(USER_FLOW_CLOSING);
      const zippedImagePath = Object.keys(zip).find((path) => path.startsWith("assets/") && path.endsWith(".png"));
      if (zippedImagePath === undefined) throw new Error("ZIP 中缺少本地图片");
      expect(sha256(Buffer.from(zip[zippedImagePath] ?? []))).toBe(seed.imageSha256);

      const offlineDir = join(work, "offline");
      for (const [path, bytes] of Object.entries(zip)) {
        await mkdir(dirname(join(offlineDir, path)), { recursive: true });
        await writeFile(join(offlineDir, path), bytes);
      }
      await context.setOffline(true);
      const offlineRequestStart = requests.length;
      await page.goto(pathToFileURL(join(offlineDir, "index.html")).href);
      await expectText(page.locator(".slide.is-active"), USER_FLOW_PARAGRAPH);
      await expect.poll(() => page.locator(".slide.is-active img").first()
        .evaluate((element) => element instanceof HTMLImageElement ? element.naturalWidth : 0)).toBeGreaterThan(0);
      await page.locator("[data-next]").click();
      await expectText(page.locator(".slide.is-active"), "今日执行");
      await page.locator("[data-prev]").click();
      await expectText(page.locator(".slide.is-active"), USER_FLOW_PARAGRAPH);
      expect(requests.slice(offlineRequestStart).filter(isExternalHttp)).toEqual([]);

      expect(requests.filter(isExternalHttp)).toEqual([]);
      expect(requests.some((url) => url.startsWith(app.base))).toBe(true);
      assertDurableResult(app, provider);
    } finally {
      await provider.close();
      if (previousEntry === undefined) delete process.env["DCW_WORKER_ENTRY"];
      else process.env["DCW_WORKER_ENTRY"] = previousEntry;
      if (previousCredential === undefined) delete process.env[USER_FLOW_CREDENTIAL_ENV];
      else process.env[USER_FLOW_CREDENTIAL_ENV] = previousCredential;
    }
  }, 150_000);
});

function assertDurableResult(app: { context: AppContext }, provider: UserFlowProvider): void {
  const db = app.context.database.db;
  expect(count(app, "authoring_confirmations")).toBe(1);
  expect(count(app, "authoring_proposals")).toBe(2);
  expect(count(app, "revisions", "created_by = 'ai_accepted'")).toBe(1);
  expect(count(app, "exports")).toBe(1);
  expect(count(app, "export_jobs")).toBe(1);
  expect(count(app, "export_artifacts")).toBe(1);
  expect(count(app, "jobs", "type = 'export_output'")).toBe(1);
  expect(count(app, "provider_calls")).toBe(5);
  expect(provider.count("intent")).toBe(2);
  expect(provider.count("recommend")).toBe(2);
  expect(provider.count("write_deck")).toBe(1);

  const revision = z.strictObject({ ast_json: z.string() }).parse(
    db.prepare("SELECT ast_json FROM revisions WHERE created_by = 'ai_accepted'").get());
  const ast = AstSchema.parse(JSON.parse(revision.ast_json));
  if (ast.kind !== "html_deck") throw new Error("已接受修订不是演示文稿");
  expect(ast.slides).toHaveLength(2);
  expect(ast.slides.every((slide) => slide.blocks.length > 0)).toBe(true);
  expect(ast.slides.map((slide) => slide.title)).toEqual(["库存三步核对", "今日执行"]);
  expect(ast.slides.flatMap((slide) => slide.blocks).map((block) => block.type)).toEqual(["paragraph", "image", "list"]);
  expect(revision.ast_json).toContain(USER_FLOW_PARAGRAPH);
  expect(revision.ast_json).toContain(USER_FLOW_CLOSING);
}

function count(app: { context: AppContext }, table: string, where?: string): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where === undefined ? "" : ` WHERE ${where}`}`;
  return z.strictObject({ n: z.number() }).parse(app.context.database.db.prepare(sql).get()).n;
}

function observeRequests(context: BrowserContext): string[] {
  const urls: string[] = [];
  context.on("request", (request) => { urls.push(request.url()); });
  return urls;
}

function isExternalHttp(raw: string): boolean {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForVisible(locator: Locator, timeout = 15_000): Promise<void> {
  await locator.waitFor({ state: "visible", timeout });
}

async function waitForEnabled(locator: Locator, timeout = 15_000): Promise<void> {
  await locator.waitFor({ state: "visible", timeout });
  await expect.poll(() => locator.isEnabled(), { timeout }).toBe(true);
}

async function expectText(locator: Locator, text: string, timeout = 15_000): Promise<void> {
  await expect.poll(async () => await locator.textContent(), { timeout }).toContain(text);
}

async function startWorkflowApp(): Promise<{ context: AppContext; config: RuntimeConfig; base: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "dcw-composer-flow-data-"));
  temporary.push(dataRoot);
  const port = await freePort();
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port,
    dataRoot,
    dbPath: join(dataRoot, "db", "workbench.sqlite"),
    backupDir: join(dataRoot, "backups"),
    webRoot: resolve(root, "dist", "web"),
    workerPoolSize: 1,
    devOrigins: [],
  };
  const context = await createApp({ config, startWorkers: true });
  await context.app.listen({ host: "127.0.0.1", port });
  return { context, config, base: `http://127.0.0.1:${port}` };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolvePort) => server.close(() => resolvePort()));
  return port;
}
