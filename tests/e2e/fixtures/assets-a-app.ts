import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, test as base, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import {
  ApiSuccessSchema,
  AssetDetailV2Schema,
  AssetListSchema,
  AssetPatchResultSchema,
  HealthSchema,
  ImportDetailSchema,
  PatchAssetRequestSchema,
  ScanDetailSchema,
  ScanItemViewSchema,
} from "@dmall/contracts";

export const evidenceRoot = "/Users/wangyun/Projects/AI-Harness/agent-evidence/recast/20261023-assets-a-implementation";
export const beforeText = "ASSETS_A_BEFORE：盘点结束后，先核对货架上的商品数量。";
export const afterText = "ASSETS_A_AFTER：图片展示完成后，记录补货数量并安排复查。";
export const materialUsage = "ASSETS_A_MATERIAL：用于盘点培训的原图，保留货架细节。";

const scanCreatedSchema = z.object({ scanId: z.uuid(), jobId: z.uuid() });
const importCreatedSchema = z.object({ importId: z.uuid(), jobId: z.uuid() });
const scanItemsSchema = z.object({ items: z.array(ScanItemViewSchema), total: z.int() });

async function getData<T>(api: APIRequestContext, path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await api.get(path);
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return ApiSuccessSchema(schema).parse(await response.json()).data;
}

async function writeData<T>(input: {
  api: APIRequestContext;
  csrfToken: string;
  method: "POST" | "PATCH";
  path: string;
  body: unknown;
  schema: z.ZodType<T>;
}): Promise<T> {
  const response = await input.api.fetch(input.path, {
    method: input.method,
    headers: { "x-csrf-token": input.csrfToken, "idempotency-key": randomUUID() },
    data: input.body,
  });
  expect(response.ok(), `${input.method} ${input.path}: ${await response.text()}`).toBe(true);
  return ApiSuccessSchema(input.schema).parse(await response.json()).data;
}

export async function generateMedia(root: string) {
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  const image = join(mediaRoot, "shelf-original.png");
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1200"><defs><linearGradient id="g"><stop stop-color="#fbbc42"/><stop offset="1" stop-color="#245e80"/></linearGradient></defs><rect width="1920" height="1200" fill="url(#g)"/><path d="M80 400H1840M80 800H1840M480 80V1120M960 80V1120M1440 80V1120" stroke="white" stroke-width="20"/><text x="100" y="180" font-size="80">ASSETS A ORIGINAL 1920 x 1200</text></svg>`)).png().toFile(image);

  const ffmpeg = process.env.DCW_E2E_FFMPEG ?? "ffmpeg";
  const video = join(mediaRoot, "shelf-motion.mp4");
  const gif = join(mediaRoot, "shelf-animation.gif");
  for (const [file, args] of [
    [video, ["-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]],
    [gif, ["-t", "2", "-vf", "fps=6", "-loop", "0"]],
  ] satisfies Array<[string, string[]]>) {
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", ...args, file], { encoding: "utf8", timeout: 30_000 });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`生成 ${file} 失败，需要含 libx264 的 ffmpeg：${result.error?.message ?? result.stderr}`);
    }
  }
  const gifMetadata = await sharp(gif, { animated: true }).metadata();
  expect(gifMetadata.pages).toBeGreaterThan(1);
  expect(gifMetadata.delay?.some((delay) => delay > 0)).toBe(true);

  await writeFile(join(root, "docs", "shelf-guide.md"), [
    "# 货架盘点手册", "", "## 实操步骤", "", beforeText, "",
    "![货架原图](../media/shelf-original.png)", "", afterText, "",
  ].join("\n"));
  await writeFile(join(root, "docs", "material-usage.md"), [
    "# Material usage", "", "| File | Use |", "|---|---|",
    `| media/shelf-original.png | ${materialUsage} |`,
    "| media/shelf-animation.gif | ASSETS_A_GIF：展示连续盘点动作。 |",
    "| media/shelf-motion.mp4 | ASSETS_A_VIDEO：用于播放与拖动进度验证。 |", "",
  ].join("\n"));

  return {
    image: { path: image, sha256: await sha256(image) },
    gif: { path: gif, sha256: await sha256(gif), frames: gifMetadata.pages },
    video: { path: video, sha256: await sha256(video) },
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close((error) => error === undefined ? resolve() : reject(error)));
  if (address === null || typeof address === "string") throw new Error("无法分配独立 E2E 端口");
  return address.port;
}

async function importMedia(api: APIRequestContext, fixtureRoot: string, csrfToken: string) {
  const write = <T>(path: string, body: unknown, schema: z.ZodType<T>) => writeData({ api, csrfToken, method: "POST", path, body, schema });
  const scan = await write("/api/v1/imports/scan", {
    schemaVersion: 1, sourceKind: "local_directory", rootPath: fixtureRoot, options: { generatePreviews: true },
  }, scanCreatedSchema);
  await expect.poll(async () => {
    const detail = await getData(api, `/api/v1/imports/scans/${scan.scanId}`, ScanDetailSchema);
    expect(["failed", "cancelled", "expired"]).not.toContain(detail.status);
    return detail.status;
  }, { timeout: 60_000, message: "真实目录扫描必须完成" }).toBe("ready");
  const items = await getData(api, `/api/v1/imports/scans/${scan.scanId}/items?limit=100`, scanItemsSchema);
  expect(items.total).toBe(5);
  expect(items.items.every((item) => item.status === "candidate")).toBe(true);
  const mapping = items.items.find((item) => item.relativePath === "docs/material-usage.md");
  if (mapping === undefined) throw new Error("真实扫描未返回 material usage 文档");
  const imported = await write("/api/v1/imports", {
    schemaVersion: 1,
    scanId: scan.scanId,
    selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
    options: { generatePreviews: true, ocr: "blocked", allowExternalModel: false, allowFeishu: false },
    assetMap: { format: "markdown-asset-table/v1", sourceScanItemIds: [mapping.id] },
  }, importCreatedSchema);
  await expect.poll(async () => {
    const detail = await getData(api, `/api/v1/imports/${imported.importId}?limit=100`, ImportDetailSchema);
    expect(["failed", "cancelled", "partial"]).not.toContain(detail.status);
    return detail.status;
  }, { timeout: 90_000, message: "真实导入必须成功，包括 GIF/video 媒体处理和 assetMap" }).toBe("succeeded");
  const detail = await getData(api, `/api/v1/imports/${imported.importId}?limit=100`, ImportDetailSchema);
  expect(detail.counts).toMatchObject({ failed: 0, committed: 5 });
  expect(detail.mapping).toMatchObject({ status: "applied", entryCount: 3, linkedEntryCount: 3, warningCount: 0 });
  const list = await getData(api, "/api/v1/assets?limit=100", AssetListSchema);
  expect(list.total).toBe(3);
  const asset = (kind: "image" | "gif" | "video") => {
    const row = list.items.find((item) => item.mediaKind === kind);
    if (row === undefined) throw new Error(`真实导入缺少 ${kind}`);
    expect(row.availability).toBe("available");
    return row;
  };
  return { image: asset("image"), gif: asset("gif"), video: asset("video"), importDetail: detail };
}

async function startApp(playwright: PlaywrightWorkerArgs["playwright"]) {
  await mkdir(evidenceRoot, { recursive: true });
  const runRoot = await mkdtemp(join(evidenceRoot, "assets-a-e2e-"));
  const dataRoot = join(runRoot, "data");
  const fixtureRoot = join(runRoot, "fixtures");
  const media = await generateMedia(fixtureRoot);
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const log = openSync(join(runRoot, "server.log"), "a");
  const server = spawn(process.execPath, ["dist/apps/server/main.js"], {
    env: { ...process.env, DCW_DATA_ROOT: dataRoot, DCW_PORT: String(port), DCW_WEB_ROOT: join(process.cwd(), "dist/web"), DCW_WORKER_POOL_SIZE: "2", DCW_LOG_LEVEL: "warn" },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  let startError: Error | undefined;
  server.on("error", (error) => { startError = error; });
  const api = await playwright.request.newContext({ baseURL });
  const close = async () => {
    try {
      await api.dispose();
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const stopped = new Promise<void>((resolve) => server.once("exit", () => resolve()));
        server.kill("SIGTERM");
        const exited = await Promise.race([stopped.then(() => true), setTimeout(5_000, false)]);
        if (!exited) {
          server.kill("SIGKILL");
          await stopped;
        }
      }
      await rm(dataRoot, { recursive: true, force: true });
      await writeFile(join(runRoot, "cleanup.json"), JSON.stringify({ serverStopped: true, dataRootRemoved: dataRoot, fixturesRetained: fixtureRoot }));
    }
  };
  try {
    await expect.poll(async () => {
      if (startError !== undefined) throw startError;
      expect(server.exitCode, `服务提前退出，查看 ${runRoot}/server.log；先运行 pnpm build`).toBeNull();
      try { return (await api.get("/api/v1/health", { timeout: 1_000 })).ok(); } catch { return false; }
    }, { timeout: 15_000, message: `独立服务启动失败，查看 ${runRoot}/server.log` }).toBe(true);
    const health = await getData(api, "/api/v1/health", HealthSchema);
    const assets = await importMedia(api, fixtureRoot, health.csrfToken);
    const detail = (id: string) => getData(api, `/api/v1/assets/${id}`, AssetDetailV2Schema);
    const patch = (id: string, body: z.infer<typeof PatchAssetRequestSchema>) => writeData({ api, csrfToken: health.csrfToken, method: "PATCH", path: `/api/v1/assets/${id}`, body: PatchAssetRequestSchema.parse(body), schema: AssetPatchResultSchema });
    await writeFile(join(runRoot, "manifest.json"), JSON.stringify({ baseURL, dataRoot, fixtureRoot, media, assets }, null, 2));
    return { api, baseURL, runRoot, fixtureRoot, media, assets, detail, patch, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type AssetsApp = Awaited<ReturnType<typeof startApp>>;

export const test = base.extend<object, { assetsApp: AssetsApp }>({
  assetsApp: [async ({ playwright }, use) => {
    const app = await startApp(playwright);
    try { await use(app); } finally { await app.close(); }
  }, { scope: "worker", timeout: 180_000 }],
  baseURL: async ({ assetsApp }, use) => { await use(assetsApp.baseURL); },
});
