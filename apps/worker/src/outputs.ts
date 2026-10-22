import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import {
  ProjectBundleManifestSchema,
  type BundleImportJobResult,
  type ExportJobResult,
  type ExportWarning,
  type FeishuPullJobResult,
  type FeishuPublishResult,
  type JobCheckpoint,
  type JobGrant,
  type ProjectBundleEntities,
  type ProjectBundleImportPayload,
} from "@dmall/contracts";
import {
  buildFeishuPublishPlan,
  renderProductionOutput,
  unzipFiles,
  writeZipFile,
  type FeishuPlannedBlock,
  type OutputStaticizedMedia,
  type ZipEntryInput,
} from "@dmall/renderers";
import { WorkerTaskError } from "./task-error.js";
import { FeishuClient, type FeishuBlock } from "./feishu-client.js";

export class RemoteResultUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteResultUnknownError";
  }
}

export class OutputWaitingError extends Error {
  constructor() {
    super("output job is waiting for input");
    this.name = "OutputWaitingError";
  }
}

export interface OutputJobDeps {
  emitCheckpoint(checkpoint: JobCheckpoint): void;
  emitProgress(phase: string, done: number | null, total: number | null, message: string): void;
  waitForInput(checkpoint: JobCheckpoint, reason: string, message: string): Promise<void>;
  withRemoteOperation<T>(input: {
    kind: "feishu_create_document" | "feishu_create_blocks" | "feishu_update_blocks" | "feishu_upload_media";
    requestHash: string;
    clientToken: string | null;
  }, action: () => Promise<T>): Promise<T>;
}

type FeishuPublishInput = Extract<JobGrant["input"], { jobType: "feishu_publish" }>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized === "" ? "output" : normalized.slice(0, 120);
}

function assertWorkspace(grant: JobGrant): string {
  if (grant.workspacePath === undefined) {
    throw new WorkerTaskError("INTERNAL_ERROR", "输出任务缺少独立工作目录");
  }
  return resolve(grant.workspacePath);
}

function blobRoot(grant: JobGrant): string {
  if (grant.blobRoot === undefined) {
    throw new WorkerTaskError("INTERNAL_ERROR", "输出任务缺少素材根目录");
  }
  return resolve(grant.blobRoot);
}

function relativeInside(root: string, candidate: string): string {
  const full = resolve(candidate);
  const base = resolve(root);
  if (full !== base && !full.startsWith(`${base}/`)) {
    throw new WorkerTaskError("PATH_NOT_ALLOWED", "输出文件路径越界");
  }
  return full;
}

interface RenderMedia {
  map: Record<string, string>;
  files: Array<{ path: string; mime: string; sha256: string; bytes: number }>;
  staticized: OutputStaticizedMedia[];
  warnings: ExportWarning[];
}

async function stageRenderMedia(grant: JobGrant, workspace: string, pdfMode: boolean): Promise<RenderMedia> {
  if (grant.input.jobType !== "export_output") {
    throw new WorkerTaskError("INTERNAL_ERROR", "媒体准备只用于导出任务");
  }
  const root = blobRoot(grant);
  const assetsDir = join(workspace, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const map: Record<string, string> = {};
  const files: RenderMedia["files"] = [];
  const staticized: OutputStaticizedMedia[] = [];
  const warnings: ExportWarning[] = [];
  for (const [index, media] of grant.input.media.entries()) {
    const source = relativeInside(root, join(root, media.relativePath));
    if (!existsSync(source)) {
      throw new WorkerTaskError("EXPORT_MEDIA_MISSING", `导出媒体文件缺失：${media.key}`);
    }
    const safeBase = `${String(index + 1).padStart(3, "0")}-${safeName(media.originalName)}`;
    if (pdfMode && media.mime === "image/gif") {
      const destination = join(assetsDir, `${safeBase.replace(/\.gif$/iu, "")}-still.png`);
      await sharp(source, { animated: false, page: 0 }).png().toFile(destination);
      const bytes = statSync(destination).size;
      map[media.key] = relative(workspace, destination).split("\\").join("/");
      files.push({ path: destination, mime: "image/png", sha256: sha256(readFileSync(destination)), bytes });
      staticized.push({
        nodeId: media.assetVersionId ?? media.derivativeId ?? media.key,
        from: "gif",
        message: "GIF 在 PDF 中静态化为首帧",
      });
      continue;
    }
    const destination = join(assetsDir, safeBase);
    copyFileSync(source, destination);
    const bytes = statSync(destination).size;
    map[media.key] = relative(workspace, destination).split("\\").join("/");
    files.push({ path: destination, mime: media.mime, sha256: sha256(readFileSync(destination)), bytes });
    if (pdfMode && media.mediaKind === "gif") {
      staticized.push({
        nodeId: media.assetVersionId ?? media.derivativeId ?? media.key,
        from: "gif",
        message: "GIF 在 PDF 中静态化为首帧",
      });
    }
  }
  if (grant.input.templateVersionId === null) {
    warnings.push({
      code: "BUILTIN_TEMPLATE_FALLBACK",
      message: "修订没有固定模板版本，使用内置基础模板快照输出。",
    });
  }
  return { map, files, staticized, warnings };
}

export async function runExportOutputJob(grant: JobGrant, deps: OutputJobDeps): Promise<ExportJobResult> {
  if (grant.input.jobType !== "export_output") {
    throw new WorkerTaskError("INTERNAL_ERROR", "导出任务输入类型不匹配");
  }
  const workspace = assertWorkspace(grant);
  const outputDir = join(workspace, "output");
  mkdirSync(outputDir, { recursive: true });
  if (grant.input.format === "project_bundle") {
    return runBundleExport(grant, deps, workspace, outputDir);
  }
  const pdfMode = grant.input.format === "pdf";
  deps.emitProgress("render_media", 0, 3, "准备导出媒体");
  const media = await stageRenderMedia(grant, workspace, pdfMode);
  deps.emitProgress("render_html", 1, 3, "渲染受控页面");
  const rendered = renderProductionOutput({
    ast: grant.input.ast,
    template: grant.input.templatePackage,
    media: media.map,
    includeSpeakerNotes: grant.input.options.speakerNotes,
    mode: pdfMode ? "pdf" : "html",
  });
  if (!rendered.ok || rendered.issues.length > 0) {
    throw new WorkerTaskError(
      "EXPORT_MEDIA_MISSING",
      rendered.issues.map((issue) => issue.message).join("；") || "导出渲染失败",
    );
  }
  const staticized = [
    ...media.staticized,
    ...rendered.staticized,
  ];
  const warnings = [
    ...media.warnings,
    ...(pdfMode && staticized.length > 0
      ? [{ code: "PDF_STATICIZED", message: "PDF 为静态输出，视频与 GIF 已选择代表帧。" }]
      : []),
  ];
  if (pdfMode) {
    const htmlPath = join(workspace, "print.html");
    writeFileSync(htmlPath, rendered.html, "utf8");
    deps.emitProgress("render_pdf", 2, 3, "Chromium 打印 PDF");
    const pdfPath = join(outputDir, `${safeName(grant.input.title)}.pdf`);
    await renderPdf(htmlPath, pdfPath);
    const bytes = readFileSync(pdfPath);
    deps.emitProgress("done", 3, 3, "PDF 输出完成");
    return {
      schemaVersion: 1,
      jobType: "export_output",
      exportId: grant.input.exportId,
      format: "pdf",
      rendererVersion: "output-pdf-1",
      files: [{
        relativePath: relative(workspace, pdfPath).split("\\").join("/"),
        role: "primary",
        mime: "application/pdf",
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        fileName: `${safeName(grant.input.title)}.pdf`,
      }],
      primaryFile: relative(workspace, pdfPath).split("\\").join("/"),
      warnings,
      manifestHash: sha256(rendered.html),
      staticizedMedia: dedupeStaticized(staticized) as ExportJobResult["staticizedMedia"],
    };
  }
  const indexBytes = Buffer.from(rendered.html, "utf8");
  const assetEntries: ZipEntryInput[] = media.files.map((file) => ({
    path: `assets/${file.path.split("/").at(-1) ?? "asset.bin"}`,
    sourcePath: file.path,
    compress: false,
  }));
  const fontNotice = [
    "本离线包不包含远程字体，也不复制系统字体。",
    "渲染使用设备本地中文字体回退：PingFang SC、Hiragino Sans GB、Microsoft YaHei、Noto Sans CJK SC。",
    "如需完全一致的排版，请在目标机器安装上述任一字体。",
  ].join("\n");
  const assetNotice = "本目录只包含本次修订实际引用的派生媒体，不是完整素材库。";
  const manifestBase = {
    schemaVersion: 1,
    kind: "dcw_offline_html",
    revisionId: grant.input.revisionId,
    contentId: grant.input.contentId,
    renditionId: grant.input.renditionId,
    templateVersionId: grant.input.templateVersionId,
    rendererVersion: "output-html-1",
    generatedAt: new Date().toISOString(),
    title: grant.input.title,
    speakerNotes: grant.input.options.speakerNotes,
    warnings,
    staticizedMedia: dedupeStaticized(staticized) as ExportJobResult["staticizedMedia"],
    files: [
      { path: "index.html", mime: "text/html; charset=utf-8", bytes: indexBytes.byteLength, sha256: sha256(indexBytes) },
      ...media.files.map((file) => ({
        path: `assets/${file.path.split("/").at(-1) ?? "asset.bin"}`,
        mime: file.mime,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      {
        path: "assets/NOTICE.txt",
        mime: "text/plain; charset=utf-8",
        bytes: Buffer.byteLength(assetNotice),
        sha256: sha256(assetNotice),
      },
      {
        path: "fonts/NOTICE.txt",
        mime: "text/plain; charset=utf-8",
        bytes: Buffer.byteLength(fontNotice),
        sha256: sha256(fontNotice),
      },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifestBase, null, 2), "utf8");
  const zipPath = join(outputDir, `${safeName(grant.input.title)}-offline.zip`);
  await writeZipFile(zipPath, [
    { path: "index.html", bytes: indexBytes },
    ...assetEntries,
    { path: "assets/NOTICE.txt", bytes: Buffer.from(assetNotice, "utf8") },
    { path: "fonts/NOTICE.txt", bytes: Buffer.from(fontNotice, "utf8") },
    { path: "manifest.json", bytes: manifestBytes },
  ]);
  const zipBytes = readFileSync(zipPath);
  deps.emitProgress("done", 3, 3, "离线 HTML ZIP 输出完成");
  return {
    schemaVersion: 1,
    jobType: "export_output",
    exportId: grant.input.exportId,
    format: "html_zip",
    rendererVersion: "output-html-1",
    files: [{
      relativePath: relative(workspace, zipPath).split("\\").join("/"),
      role: "primary",
      mime: "application/zip",
      bytes: zipBytes.byteLength,
      sha256: sha256(zipBytes),
      fileName: `${safeName(grant.input.title)}-offline.zip`,
    }],
    primaryFile: relative(workspace, zipPath).split("\\").join("/"),
    warnings,
    manifestHash: sha256(manifestBytes),
    staticizedMedia: dedupeStaticized(staticized) as ExportJobResult["staticizedMedia"],
  };
}

async function runBundleExport(
  grant: JobGrant,
  deps: OutputJobDeps,
  workspace: string,
  outputDir: string,
): Promise<ExportJobResult> {
  if (grant.input.jobType !== "export_output" || grant.input.format !== "project_bundle") {
    throw new WorkerTaskError("INTERNAL_ERROR", "项目包导出输入不匹配");
  }
  if (grant.input.bundle === undefined) {
    throw new WorkerTaskError("INTERNAL_ERROR", "项目包导出缺少实体计划");
  }
  deps.emitProgress("bundle_entities", 0, 3, "整理项目包实体");
  const entitiesBytes = Buffer.from(JSON.stringify(grant.input.bundle.entities, null, 2), "utf8");
  const entitiesHash = sha256(entitiesBytes);
  const manifest = ProjectBundleManifestSchema.parse({
    schemaVersion: 1,
    kind: "dcw_project_bundle",
    bundleVersion: 1,
    internal: true,
    notice: "内部资料项目包，用于回到工作台续改；不是对外演示成品。",
    createdBy: "dmall-content-workbench",
    appVersion: "0.1.0",
    rendererVersion: "bundle-1",
    contentId: grant.input.contentId,
    title: grant.input.title,
    selections: grant.input.bundle.selections,
    entitiesPath: "data/entities.json",
    entitiesSha256: entitiesHash,
    blobs: grant.input.bundle.blobs,
    counts: {
      renditions: grant.input.bundle.entities.renditions.length,
      revisions: grant.input.bundle.entities.revisions.length,
      templates: grant.input.bundle.entities.templateVersions.length,
      assets: grant.input.bundle.entities.assetVersions.length,
      sources: grant.input.bundle.entities.sourceVersions.length,
      messages: grant.input.bundle.entities.messages.length,
    },
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const root = blobRoot(grant);
  const entries: ZipEntryInput[] = [
    { path: "manifest.json", bytes: manifestBytes },
    { path: "data/entities.json", bytes: entitiesBytes },
    {
      path: "README.txt",
      bytes: Buffer.from("内部资料项目包。导入工作台后会创建新的内容实体，不覆盖本机既有内容。\n", "utf8"),
    },
  ];
  for (const blob of grant.input.bundle.blobs) {
    const source = relativeInside(root, join(root, "blobs", "sha256", blob.sha256.slice(0, 2), blob.sha256));
    if (!existsSync(source)) {
      throw new WorkerTaskError("EXPORT_MEDIA_MISSING", `项目包媒体缺失：${blob.sha256.slice(0, 12)}`);
    }
    const actual = sha256(readFileSync(source));
    if (actual !== blob.sha256) {
      throw new WorkerTaskError("EXPORT_MEDIA_MISSING", `项目包媒体哈希不匹配：${blob.sha256.slice(0, 12)}`);
    }
    entries.push({ path: blob.path, sourcePath: source, compress: false });
  }
  const zipPath = join(outputDir, `${safeName(grant.input.title)}-project.zip`);
  await writeZipFile(zipPath, entries);
  const zipBytes = readFileSync(zipPath);
  deps.emitProgress("done", 3, 3, "项目包输出完成");
  return {
    schemaVersion: 1,
    jobType: "export_output",
    exportId: grant.input.exportId,
    format: "project_bundle",
    rendererVersion: "bundle-1",
    files: [{
      relativePath: relative(workspace, zipPath).split("\\").join("/"),
      role: "primary",
      mime: "application/zip",
      bytes: zipBytes.byteLength,
      sha256: sha256(zipBytes),
      fileName: `${safeName(grant.input.title)}-project.zip`,
    }],
    primaryFile: relative(workspace, zipPath).split("\\").join("/"),
    warnings: [{ code: "INTERNAL_BUNDLE", message: "项目包含内部会话与来源引用，不得直接作为对外演示包。" }],
    manifestHash: sha256(manifestBytes),
    staticizedMedia: [],
  };
}

async function renderPdf(htmlPath: string, pdfPath: string): Promise<void> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath === undefined || executablePath === "" ? {} : { executablePath }),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(pathToFileURL(htmlPath).href);
    await waitForStablePage(page);
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    await browser.close();
  }
}

async function waitForStablePage(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images);
    await Promise.all(images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise((resolveImage) => {
          image.addEventListener("load", resolveImage, { once: true });
          image.addEventListener("error", resolveImage, { once: true });
        })));
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
}

function dedupeStaticized(values: OutputStaticizedMedia[]): OutputStaticizedMedia[] {
  const map = new Map<string, OutputStaticizedMedia>();
  for (const value of values) map.set(`${value.nodeId}:${value.from}`, value);
  return [...map.values()];
}

export async function runBundleImportJob(grant: JobGrant): Promise<BundleImportJobResult> {
  if (grant.input.jobType !== "project_bundle_import") {
    throw new WorkerTaskError("INTERNAL_ERROR", "项目包导入输入不匹配");
  }
  const workspace = assertWorkspace(grant);
  const bundlePath = resolve(grant.input.bundlePath);
  if (!existsSync(bundlePath)) {
    throw new WorkerTaskError("BUNDLE_INVALID", "项目包文件不存在");
  }
  const bundleBytes = readFileSync(bundlePath);
  if (sha256(bundleBytes) !== grant.input.bundleSha256) {
    throw new WorkerTaskError("BUNDLE_INVALID", "项目包 SHA-256 不匹配");
  }
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipFiles(bundleBytes);
  } catch {
    throw new WorkerTaskError("BUNDLE_INVALID", "项目包不是有效 ZIP");
  }
  const manifestBytes = zip["manifest.json"];
  if (manifestBytes === undefined) {
    throw new WorkerTaskError("BUNDLE_INVALID", "项目包缺少 manifest.json");
  }
  const manifest = ProjectBundleManifestSchema.parse(
    JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown,
  );
  const entitiesBytes = zip[manifest.entitiesPath];
  if (entitiesBytes === undefined) {
    throw new WorkerTaskError("BUNDLE_INVALID", "项目包缺少实体数据");
  }
  if (sha256(entitiesBytes) !== manifest.entitiesSha256) {
    throw new WorkerTaskError("BUNDLE_INVALID", "项目包实体数据哈希不匹配");
  }
  const entities = JSON.parse(Buffer.from(entitiesBytes).toString("utf8")) as unknown as ProjectBundleEntities;
  const mediaDir = join(workspace, "bundle-media");
  mkdirSync(mediaDir, { recursive: true });
  const blobs: ProjectBundleImportPayload["blobs"] = [];
  for (const blob of manifest.blobs) {
    const bytes = zip[blob.path];
    if (bytes === undefined) {
      throw new WorkerTaskError("BUNDLE_INVALID", `项目包媒体不存在：${blob.path}`);
    }
    if (bytes.byteLength !== blob.bytes || sha256(bytes) !== blob.sha256) {
      throw new WorkerTaskError("BUNDLE_INVALID", `项目包媒体校验失败：${blob.path}`);
    }
    const fileName = `${blob.sha256}`;
    const destination = join(mediaDir, fileName);
    writeFileSync(destination, bytes);
    blobs.push({
      ...blob,
      workspacePath: relative(workspace, destination).split("\\").join("/"),
    });
  }
  const payload: ProjectBundleImportPayload = {
    schemaVersion: 1,
    kind: "dcw_project_bundle_payload",
    bundleSha256: grant.input.bundleSha256,
    originalTitle: manifest.title,
    entities,
    blobs,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  const payloadPath = "bundle-payload.json";
  writeFileSync(join(workspace, payloadPath), payloadBytes);
  return {
    schemaVersion: 1,
    jobType: "project_bundle_import",
    importId: grant.input.importId,
    bundleSha256: grant.input.bundleSha256,
    payloadPath,
    payloadSha256: sha256(payloadBytes),
    originalTitle: manifest.title,
    counts: {
      blobs: blobs.length,
      renditions: entities.renditions.length,
      revisions: entities.revisions.length,
      assetVersions: entities.assetVersions.length,
      messages: entities.messages.length,
    },
  };
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function clientToken(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function textElement(run: {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: string | null;
}): Record<string, unknown> {
  return {
    text_run: {
      content: run.text,
      text_element_style: {
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italic: true } : {}),
        ...(run.code ? { inline_code: true } : {}),
        ...(run.link === null ? {} : { link: { url: encodeURIComponent(run.link) } }),
      },
    },
  };
}

function textBlockPayload(kind: "text" | "heading" | "bullet" | "ordered", runs: Array<{
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: string | null;
}>, level = 1): Record<string, unknown> {
  const elements = runs.map(textElement);
  if (kind === "text") {
    return { block_type: 2, text: { elements, style: {} } };
  }
  if (kind === "heading") {
    const blockType = 2 + Math.max(1, Math.min(9, level));
    return { block_type: blockType, [`heading${Math.max(1, Math.min(9, level))}`]: { elements, style: {} } };
  }
  return {
    block_type: kind === "bullet" ? 12 : 13,
    [kind]: { elements, style: {} },
  };
}

function plannedPayload(block: FeishuPlannedBlock): {
  payloads: Record<string, unknown>[];
  special: "table" | "image" | null;
  mediaKey: string | null;
  caption: string;
} {
  switch (block.kind) {
    case "heading":
      return { payloads: [textBlockPayload("heading", block.runs, block.level)], special: null, mediaKey: null, caption: "" };
    case "paragraph":
      return { payloads: [textBlockPayload("text", block.runs)], special: null, mediaKey: null, caption: "" };
    case "callout":
      return {
        payloads: [textBlockPayload("text", [{
          text: "提示：",
          bold: true,
          italic: false,
          code: false,
          link: null,
        }, ...block.runs])],
        special: null,
        mediaKey: null,
        caption: "",
      };
    case "list":
      return {
        payloads: block.items.map((item) => textBlockPayload(block.ordered ? "ordered" : "bullet", item)),
        special: null,
        mediaKey: null,
        caption: "",
      };
    case "divider":
      return { payloads: [{ block_type: 22, divider: {} }], special: null, mediaKey: null, caption: "" };
    case "readonly_source":
      return {
        payloads: [textBlockPayload("text", [{
          text: `【只读来源：${block.sourceBlockType}】${block.summary}`,
          bold: false,
          italic: false,
          code: false,
          link: block.url,
        }])],
        special: null,
        mediaKey: null,
        caption: "",
      };
    case "table":
      return {
        payloads: [{
          block_type: 31,
          table: {
            property: {
              row_size: block.rows.length + 1,
              column_size: block.columns.length,
              column_width: block.columns.map(() => 220),
            },
          },
        }],
        special: "table",
        mediaKey: null,
        caption: "",
      };
    case "image":
      return { payloads: [{ block_type: 27, image: {} }], special: "image", mediaKey: block.mediaKey, caption: block.caption || block.alt };
    case "video_poster":
      return { payloads: [{ block_type: 27, image: {} }], special: "image", mediaKey: block.mediaKey, caption: block.caption || "视频封面帧" };
  }
}

export async function runFeishuPublishJob(
  grant: JobGrant,
  deps: OutputJobDeps,
): Promise<FeishuPublishResult | null> {
  if (grant.input.jobType !== "feishu_publish") {
    throw new WorkerTaskError("INTERNAL_ERROR", "飞书发布输入不匹配");
  }
  const input = grant.input;
  let client: FeishuClient;
  try {
    client = new FeishuClient();
  } catch {
    throw new WorkerTaskError("FEISHU_AUTH_MISSING", "飞书用户凭证未配置，发布已阻断");
  }
  const plan = buildFeishuPublishPlan(input.ast, { includeSpeakerNotes: input.options.speakerNotes });
  const mediaByKey = new Map(input.media.map((item) => [item.key, item]));
  const root = blobRoot(grant);
  const initial = grant.checkpoint?.jobType === "feishu_publish"
    ? grant.checkpoint
    : {
        schemaVersion: 1 as const,
        jobType: "feishu_publish" as const,
        phase: "not_started" as const,
        documentId: null,
        documentUrl: null,
        batchIndex: 0,
        blockMap: {},
        mediaMap: {},
        pendingTableCells: [],
      };
  let checkpoint = { ...initial, blockMap: { ...initial.blockMap }, mediaMap: { ...initial.mediaMap } };
  let documentId = checkpoint.documentId;
  let documentUrl = checkpoint.documentUrl;
  const warnings = plan.warnings.map((warning) => ({ ...warning }));
  if (documentId === null || documentUrl === null) {
    const attach = grant.remoteDecision?.kind === "feishu_attach" ? grant.remoteDecision : null;
    if (attach !== null) {
      documentId = attach.documentId;
      documentUrl = attach.documentUrl;
      checkpoint = { ...checkpoint, documentId, documentUrl, phase: "document_created" };
      deps.emitCheckpoint(checkpoint);
    } else {
      deps.emitProgress("create_document", 0, plan.blocks.length + 1, "创建新的飞书文档");
      try {
        const created = await deps.withRemoteOperation({
          kind: "feishu_create_document",
          requestHash: sha256(JSON.stringify({ title: input.title, folder: input.folderToken })),
          clientToken: null,
        }, () => client.createDocument({
          title: input.title,
          folderToken: input.folderToken,
        }));
        documentId = created.documentId;
        documentUrl = created.url;
        checkpoint = { ...checkpoint, documentId, documentUrl, phase: "document_created" };
        deps.emitCheckpoint(checkpoint);
      } catch (error) {
        if (error instanceof RemoteResultUnknownError) {
          await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "飞书创建文档结果未知，请先核对远端文档并绑定结果。");
          return null;
        }
        throw error;
      }
    }
  }
  if (documentId === null || documentUrl === null) {
    await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "缺少已确认的飞书文档，请先绑定远端结果。");
    return null;
  }

  let revisionId: number | null = null;
  const simple: FeishuPlannedBlock[] = [];
  try {
    for (const block of plan.blocks) {
      const existingBlockId = checkpoint.blockMap[block.nodeId];
      if (existingBlockId !== undefined) {
        if (
          (block.kind === "image" || block.kind === "video_poster") &&
          checkpoint.mediaMap[block.nodeId] === undefined
        ) {
          checkpoint = await attachImageToExistingBlock(
            client, deps, input, documentId, block, existingBlockId,
            mediaByKey, root, checkpoint, revisionId,
          );
        } else if (block.kind === "table") {
          checkpoint = await fillExistingTable(
            client, deps, input, documentId, block, existingBlockId, checkpoint,
          );
        }
        continue;
      }
      const special = plannedPayload(block).special;
      if (special === null) {
        simple.push(block);
        continue;
      }
      if (simple.length > 0) {
        const result = await writeSimpleBatch(client, deps, input, documentId, simple, checkpoint, revisionId);
        revisionId = result.revisionId ?? revisionId;
        checkpoint = result.checkpoint;
        simple.length = 0;
      }
      const result = await writeSpecialBlock(client, deps, input, documentId, block, mediaByKey, root, checkpoint, revisionId);
      if (result === null) return null;
      revisionId = result.revisionId ?? revisionId;
      checkpoint = result.checkpoint;
    }
    if (simple.length > 0) {
      const result = await writeSimpleBatch(client, deps, input, documentId, simple, checkpoint, revisionId);
      revisionId = result.revisionId ?? revisionId;
      checkpoint = result.checkpoint;
    }
  } catch (error) {
    if (error instanceof OutputWaitingError) return null;
    throw error;
  }
  deps.emitProgress("readback", plan.blocks.length, plan.blocks.length + 1, "全量分页读回核对");
  const readback = await readAllBlocks(client, documentId);
  const expectedText = plan.blocks.flatMap(textOfPlannedBlock).filter((value) => value !== "");
  const readbackText = readback.flatMap(textOfFeishuBlock).filter((value) => value !== "");
  if (expectedText.some((text) => !readbackText.some((remote) => remote.includes(text.slice(0, Math.min(text.length, 80)))))) {
    warnings.push({
      code: "FEISHU_READBACK_MISMATCH",
      message: "飞书读回文本与本地写入计划存在差异，已保留文档链接和块映射，请人工核对。",
    });
  }
  checkpoint = { ...checkpoint, phase: "readback_verified" };
  deps.emitCheckpoint(checkpoint);
  return {
    schemaVersion: 1,
    jobType: "feishu_publish",
    exportId: input.exportId,
    documentId,
    documentUrl,
    blockMap: checkpoint.blockMap,
    mediaMap: checkpoint.mediaMap,
    readbackHash: sha256(JSON.stringify(readback)),
    warnings,
  };
}

async function writeSimpleBatch(
  client: FeishuClient,
  deps: OutputJobDeps,
  input: FeishuPublishInput,
  documentId: string,
  blocks: FeishuPlannedBlock[],
  checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>,
  revisionId: number | null,
): Promise<{ checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>; revisionId: number | null }> {
  const payloads = blocks.flatMap((block) => plannedPayload(block).payloads);
  if (payloads.length === 0) return { checkpoint, revisionId };
  const token = clientToken(`${input.exportId}:batch:${checkpoint.batchIndex}:${blocks.map((block) => block.nodeId).join(",")}`);
  deps.emitProgress("create_blocks", checkpoint.batchIndex, checkpoint.batchIndex + payloads.length, "写入飞书正文块");
  try {
    const response = await deps.withRemoteOperation({
      kind: "feishu_create_blocks",
      requestHash: sha256(JSON.stringify(payloads)),
      clientToken: token,
    }, () => client.createChildren({
      documentId,
      parentBlockId: documentId,
      children: payloads,
      clientToken: token,
      ...(revisionId === null ? {} : { documentRevisionId: revisionId }),
    }));
    if (response.children.length !== payloads.length) {
      throw new WorkerTaskError("REMOTE_RESULT_UNKNOWN", "飞书创建块数量与计划不一致", true);
    }
    const blockMap = { ...checkpoint.blockMap };
    let cursor = 0;
    blocks.forEach((block) => {
      const count = plannedPayload(block).payloads.length;
      const remote = response.children[cursor];
      if (remote !== undefined) blockMap[block.nodeId] = remote.block_id;
      cursor += count;
    });
    const next = {
      ...checkpoint,
      phase: "blocks_created" as const,
      batchIndex: checkpoint.batchIndex + payloads.length,
      blockMap,
    };
    deps.emitCheckpoint(next);
    return { checkpoint: next, revisionId: response.revisionId ?? revisionId };
  } catch (error) {
    if (error instanceof RemoteResultUnknownError) {
      await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "飞书块写入结果未知，请核对远端文档后继续。");
      throw new OutputWaitingError();
    }
    throw error;
  }
}

async function writeSpecialBlock(
  client: FeishuClient,
  deps: OutputJobDeps,
  input: FeishuPublishInput,
  documentId: string,
  block: FeishuPlannedBlock,
  mediaByKey: Map<string, { relativePath: string; mime: string; originalName: string }>,
  root: string,
  checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>,
  revisionId: number | null,
): Promise<{ checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>; revisionId: number | null } | null> {
  const planned = plannedPayload(block);
  if (planned.payloads.length === 0) return { checkpoint, revisionId };
  const token = clientToken(`${input.exportId}:special:${block.nodeId}`);
  let created: { children: FeishuBlock[]; revisionId: number | null };
  try {
    created = await deps.withRemoteOperation({
      kind: "feishu_create_blocks",
      requestHash: sha256(JSON.stringify(planned.payloads)),
      clientToken: token,
    }, () => client.createChildren({
      documentId,
      parentBlockId: documentId,
      children: planned.payloads,
      clientToken: token,
      ...(revisionId === null ? {} : { documentRevisionId: revisionId }),
    }));
  } catch (error) {
    if (error instanceof RemoteResultUnknownError) {
      await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "飞书特殊块写入结果未知，请核对远端文档后继续。");
      throw new OutputWaitingError();
    }
    throw error;
  }
  const remote = created.children[0];
  if (remote === undefined) throw new WorkerTaskError("REMOTE_RESULT_UNKNOWN", "飞书未返回新建块", true);
  const blockMap = { ...checkpoint.blockMap, [block.nodeId]: remote.block_id };
  let next: Extract<JobCheckpoint, { jobType: "feishu_publish" }> = {
    ...checkpoint,
    phase: "blocks_created" as const,
    batchIndex: checkpoint.batchIndex + 1,
    blockMap,
    mediaMap: { ...checkpoint.mediaMap },
    pendingTableCells: block.kind === "table" ? [remote.block_id] : checkpoint.pendingTableCells,
  };
  deps.emitCheckpoint(next);
  if (block.kind === "table") {
    const cells = tableCells(remote);
    next = await fillTableCellBlocks(client, deps, input, documentId, block, cells, next);
    return { checkpoint: next, revisionId: created.revisionId ?? revisionId };
  } else if (block.kind === "image" || block.kind === "video_poster") {
    const result = await attachImageToExistingBlock(
      client, deps, input, documentId, block, remote.block_id,
      mediaByKey, root, next, created.revisionId ?? revisionId,
    );
    return { checkpoint: result, revisionId: created.revisionId ?? revisionId };
  }
  return { checkpoint: next, revisionId: created.revisionId ?? revisionId };
}

function tableCells(block: FeishuBlock): string[] {
  const table = block.table;
  if (table === null || typeof table !== "object") return [];
  const cells = (table as Record<string, unknown>).cells;
  return Array.isArray(cells) ? cells.filter((value): value is string => typeof value === "string") : [];
}

async function fillExistingTable(
  client: FeishuClient,
  deps: OutputJobDeps,
  input: FeishuPublishInput,
  documentId: string,
  block: Extract<FeishuPlannedBlock, { kind: "table" }>,
  tableBlockId: string,
  checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>,
): Promise<Extract<JobCheckpoint, { jobType: "feishu_publish" }>> {
  const children: FeishuBlock[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const response = await client.listChildren({
      documentId,
      parentBlockId: tableBlockId,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    children.push(...response.items);
    if (!response.hasMore) break;
    if (response.pageToken === null) {
      throw new WorkerTaskError("REMOTE_RESULT_UNKNOWN", "飞书表格单元格分页缺少 page_token", true);
    }
    pageToken = response.pageToken;
  }
  const cells = children.filter((item) => item.block_type === 32).map((item) => item.block_id);
  return fillTableCellBlocks(client, deps, input, documentId, block, cells, {
    ...checkpoint,
    pendingTableCells: [tableBlockId],
  });
}

async function fillTableCellBlocks(
  client: FeishuClient,
  deps: OutputJobDeps,
  input: FeishuPublishInput,
  documentId: string,
  block: Extract<FeishuPlannedBlock, { kind: "table" }>,
  cells: string[],
  checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>,
): Promise<Extract<JobCheckpoint, { jobType: "feishu_publish" }>> {
  if (cells.length !== (block.rows.length + 1) * block.columns.length) {
    throw new WorkerTaskError("REMOTE_RESULT_UNKNOWN", "飞书表格单元格数量与计划不一致", true);
  }
  const allRows = [block.columns, ...block.rows];
  for (const [index, cellId] of cells.entries()) {
    const row = allRows[Math.floor(index / block.columns.length)] ?? [];
    const value = row[index % block.columns.length] ?? "";
    const cellToken = clientToken(`${input.exportId}:cell:${block.nodeId}:${index}`);
    try {
      await deps.withRemoteOperation({
        kind: "feishu_create_blocks",
        requestHash: sha256(JSON.stringify({ cellId, value })),
        clientToken: cellToken,
      }, () => client.createChildren({
        documentId,
        parentBlockId: cellId,
        children: [textBlockPayload("text", [{
          text: value === "" ? " " : value,
          bold: false,
          italic: false,
          code: false,
          link: null,
        }])],
        clientToken: cellToken,
      }));
    } catch (error) {
      if (error instanceof RemoteResultUnknownError) {
        await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "飞书表格单元格写入结果未知，请核对远端文档后继续。");
        throw new OutputWaitingError();
      }
      throw error;
    }
  }
  const next = { ...checkpoint, pendingTableCells: [] };
  deps.emitCheckpoint(next);
  return next;
}

async function attachImageToExistingBlock(
  client: FeishuClient,
  deps: OutputJobDeps,
  input: FeishuPublishInput,
  documentId: string,
  block: Extract<FeishuPlannedBlock, { kind: "image" | "video_poster" }>,
  blockId: string,
  mediaByKey: Map<string, { relativePath: string; mime: string; originalName: string }>,
  root: string,
  checkpoint: Extract<JobCheckpoint, { jobType: "feishu_publish" }>,
  revisionId: number | null,
): Promise<Extract<JobCheckpoint, { jobType: "feishu_publish" }>> {
  const media = mediaByKey.get(block.mediaKey);
  if (media === undefined) {
    throw new WorkerTaskError("EXPORT_MEDIA_MISSING", `飞书图片缺少媒体：${block.mediaKey}`);
  }
  const filePath = relativeInside(root, join(root, media.relativePath));
  let fileToken: string;
  try {
    fileToken = await deps.withRemoteOperation({
      kind: "feishu_upload_media",
      requestHash: sha256(JSON.stringify({ blockId, media: media.relativePath })),
      clientToken: clientToken(`${input.exportId}:media:${block.nodeId}`),
    }, () => client.uploadImage({
      documentId,
      blockId,
      filePath,
      fileName: media.originalName,
    }));
  } catch (error) {
    if (error instanceof RemoteResultUnknownError) {
      await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "飞书图片上传结果未知，请核对远端文档后继续。");
      throw new OutputWaitingError();
    }
    throw error;
  }
  try {
    await deps.withRemoteOperation({
      kind: "feishu_update_blocks",
      requestHash: sha256(JSON.stringify({ blockId, fileToken })),
      clientToken: clientToken(`${input.exportId}:replace:${block.nodeId}`),
    }, () => client.patchBlock({
      documentId,
      blockId,
      body: { replace_image: { token: fileToken } },
      clientToken: clientToken(`${input.exportId}:replace:${block.nodeId}`),
      ...(revisionId === null ? {} : { documentRevisionId: revisionId }),
    }));
  } catch (error) {
    if (error instanceof RemoteResultUnknownError) {
      await deps.waitForInput(checkpoint, "REMOTE_RESULT_UNKNOWN", "飞书图片绑定结果未知，请核对远端文档后继续。");
      throw new OutputWaitingError();
    }
    throw error;
  }
  let next: Extract<JobCheckpoint, { jobType: "feishu_publish" }> = {
    ...checkpoint,
    phase: "media_uploaded",
    mediaMap: { ...checkpoint.mediaMap, [block.nodeId]: fileToken },
  };
  if (plannedPayload(block).caption.trim() !== "") {
    const captionToken = clientToken(`${input.exportId}:caption:${block.nodeId}`);
    try {
      await deps.withRemoteOperation({
        kind: "feishu_create_blocks",
        requestHash: sha256(JSON.stringify({ caption: plannedPayload(block).caption })),
        clientToken: captionToken,
      }, () => client.createChildren({
        documentId,
        parentBlockId: documentId,
        children: [textBlockPayload("text", [{
          text: plannedPayload(block).caption,
          bold: false,
          italic: false,
          code: false,
          link: null,
        }])],
        clientToken: captionToken,
      }));
    } catch (error) {
      if (error instanceof RemoteResultUnknownError) {
        await deps.waitForInput(next, "REMOTE_RESULT_UNKNOWN", "飞书图片说明写入结果未知，请核对远端文档后继续。");
        throw new OutputWaitingError();
      }
      throw error;
    }
  }
  next = { ...next, phase: "media_uploaded" };
  deps.emitCheckpoint(next);
  return next;
}

async function readAllBlocks(client: FeishuClient, documentId: string): Promise<FeishuBlock[]> {
  const items: FeishuBlock[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const response = await client.listBlocks({ documentId, ...(pageToken === undefined ? {} : { pageToken }) });
    items.push(...response.items);
    if (!response.hasMore) return items;
    if (response.pageToken === null) {
      throw new WorkerTaskError("REMOTE_RESULT_UNKNOWN", "飞书分页响应缺少 page_token", true);
    }
    pageToken = response.pageToken;
  }
  throw new WorkerTaskError("REMOTE_RESULT_UNKNOWN", "飞书分页超过上限", true);
}

function textOfPlannedBlock(block: FeishuPlannedBlock): string[] {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "callout":
      return [block.runs.map((run) => run.text).join("")];
    case "list":
      return block.items.map((item) => item.map((run) => run.text).join(""));
    case "table":
      return [block.columns.join(""), ...block.rows.map((row) => row.join(""))];
    case "readonly_source":
      return [block.summary];
    case "image":
      return [block.caption, block.alt];
    case "video_poster":
      return [block.caption];
    case "divider":
      return [];
  }
}

function textOfFeishuBlock(block: FeishuBlock): string[] {
  const result: string[] = [];
  for (const value of Object.values(block)) {
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const elements = record.elements;
    if (!Array.isArray(elements)) continue;
    const text = elements.map((element) => {
      if (element === null || typeof element !== "object") return "";
      const run = (element as Record<string, unknown>).text_run;
      if (run === null || typeof run !== "object") return "";
      const content = (run as Record<string, unknown>).content;
      return typeof content === "string" ? content : "";
    }).join("");
    if (text !== "") result.push(text);
  }
  return result;
}

export async function runFeishuPullJob(grant: JobGrant, deps: OutputJobDeps): Promise<FeishuPullJobResult> {
  if (grant.input.jobType !== "feishu_pull") {
    throw new WorkerTaskError("INTERNAL_ERROR", "飞书取回输入不匹配");
  }
  let client: FeishuClient;
  try {
    client = new FeishuClient();
  } catch {
    throw new WorkerTaskError("FEISHU_AUTH_MISSING", "飞书用户凭证未配置，取回已阻断");
  }
  const workspace = assertWorkspace(grant);
  deps.emitProgress("read_document", 0, 3, "分页读取飞书文档");
  const metadata = await client.getDocument(grant.input.remoteDocumentId);
  const blocks = await readAllBlocks(client, grant.input.remoteDocumentId);
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const mediaDir = join(workspace, "pull-media");
  mkdirSync(mediaDir, { recursive: true });
  const syntheticSourceVersionId = stableUuid(`feishu-source:${grant.input.remoteDocumentId}:${sha256(JSON.stringify(blocks))}`);
  const downloaded = await downloadFeishuImages(client, blocks, byId, mediaDir, workspace);
  deps.emitProgress("convert_ast", 2, 3, "转换为受控文档 AST");
  const ast = convertFeishuBlocks({
    title: metadata.title,
    documentUrl: metadata.url || grant.input.remoteUrl,
    blocks,
    byId,
    sourceVersionId: syntheticSourceVersionId,
    media: downloaded.media,
  });
  const snapshot = {
    schemaVersion: 1,
    documentId: grant.input.remoteDocumentId,
    documentUrl: metadata.url || grant.input.remoteUrl,
    title: metadata.title,
    remoteRevision: metadata.revisionId,
    capturedAt: new Date().toISOString(),
    blocks,
  };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2), "utf8");
  const snapshotPath = "feishu-snapshot.json";
  writeFileSync(join(workspace, snapshotPath), snapshotBytes);
  deps.emitProgress("done", 3, 3, "飞书取回预览完成");
  return {
    schemaVersion: 1,
    jobType: "feishu_pull",
    bindingId: grant.input.bindingId,
    expectedLocalRevisionId: grant.input.expectedLocalRevisionId,
    documentId: grant.input.remoteDocumentId,
    documentUrl: grant.input.remoteUrl,
    remoteRevision: metadata.revisionId === "" ? null : metadata.revisionId,
    sourceTitle: ast.title,
    syntheticSourceVersionId,
    ast,
    snapshotPath,
    snapshotSha256: sha256(snapshotBytes),
    media: downloaded.media,
    warnings: downloaded.warnings,
  };
}

async function downloadFeishuImages(
  client: FeishuClient,
  blocks: FeishuBlock[],
  byId: Map<string, FeishuBlock>,
  mediaDir: string,
  workspace: string,
): Promise<{ media: FeishuPullJobResult["media"]; warnings: ExportWarning[] }> {
  const result: FeishuPullJobResult["media"] = [];
  const warnings: ExportWarning[] = [];
  for (const block of blocks) {
    if (block.block_type !== 27) continue;
    const token = imageToken(block);
    if (token === null) continue;
    let downloaded: Awaited<ReturnType<FeishuClient["downloadMedia"]>>;
    try {
      downloaded = await client.downloadMedia(token);
    } catch (error) {
      warnings.push({
        code: "FEISHU_IMAGE_UNAVAILABLE",
        message: `飞书图片 ${block.block_id} 下载失败，已保留只读占位：${error instanceof Error ? error.message : "未知错误"}`,
      });
      continue;
    }
    const ext = downloaded.mime.includes("png") ? "png" : downloaded.mime.includes("gif") ? "gif" : deliveredExtension(downloaded.mime);
    const destination = join(mediaDir, `${safeName(token)}.${ext}`);
    writeFileSync(destination, downloaded.bytes);
    result.push({
      relativePath: relative(workspace, destination).split("\\").join("/"),
      sha256: sha256(downloaded.bytes),
      bytes: downloaded.bytes.byteLength,
      mime: downloaded.mime,
      remoteToken: token,
      blockId: block.block_id,
      assetId: stableUuid(`feishu-asset:${token}`),
      assetVersionId: stableUuid(`feishu-asset-version:${token}`),
      occurrenceId: stableUuid(`feishu-occurrence:${block.block_id}`),
    });
    void byId;
  }
  return { media: result, warnings };
}

function deliveredExtension(mime: string): string {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "bin";
}

function imageToken(block: FeishuBlock): string | null {
  const image = block.image;
  if (image === null || typeof image !== "object") return null;
  const token = (image as Record<string, unknown>).token;
  return typeof token === "string" && token !== "" ? token : null;
}

function convertFeishuBlocks(input: {
  title: string;
  documentUrl: string;
  blocks: FeishuBlock[];
  byId: Map<string, FeishuBlock>;
  sourceVersionId: string;
  media: FeishuPullJobResult["media"];
}): import("@dmall/contracts").DocAst {
  const mediaByBlock = new Map(input.media.map((item) => [item.blockId, item]));
  const sections: Array<{
    id: string;
    title: string;
    blocks: unknown[];
    locks: string[];
  }> = [];
  let current = {
    id: stableUuid("feishu-section:root"),
    title: "取回内容",
    blocks: [] as unknown[],
    locks: [] as string[],
  };
  const pageBlockId = input.blocks.find((block) => block.block_type === 1)?.block_id;
  const top = input.blocks.filter((block) =>
    block.block_type !== 1 &&
    (pageBlockId === undefined || block.parent_id === pageBlockId),
  );
  for (const block of top.length > 0 ? top : input.blocks) {
    const level = headingLevel(block.block_type);
    if (level !== null) {
      if (current.blocks.length > 0) sections.push(current);
      current = {
        id: stableUuid(`feishu-section:${block.block_id}`),
        title: textOfFeishuBlock(block).join("") || "未命名章节",
        blocks: [],
        locks: [],
      };
      continue;
    }
    const converted = convertOneBlock(block, input, mediaByBlock);
    if (converted !== null) current.blocks.push(converted);
  }
  if (current.blocks.length > 0 || sections.length === 0) sections.push(current);
  return {
    schemaVersion: 1,
    kind: "feishu_doc",
    title: input.title,
    locks: [],
    sections: sections as never,
    speakerNotes: {},
  };
}

function headingLevel(blockType: number): number | null {
  if (blockType >= 3 && blockType <= 11) return blockType - 2;
  return null;
}

function baseBlock(block: FeishuBlock, sourceVersionId: string): {
  id: string;
  provenance: unknown[];
  locks: string[];
} {
  return {
    id: stableUuid(`feishu-block:${block.block_id}`),
    provenance: [{
      kind: "source",
      sourceVersionId,
      locator: { kind: "block", blockId: block.block_id },
    }],
    locks: [],
  };
}

function convertOneBlock(
  block: FeishuBlock,
  input: Parameters<typeof convertFeishuBlocks>[0],
  mediaByBlock: Map<string, FeishuPullJobResult["media"][number]>,
): unknown | null {
  const base = baseBlock(block, input.sourceVersionId);
  if (block.block_type === 2 || block.block_type === 3) {
    return { ...base, type: "paragraph", inlines: textRuns(block) };
  }
  if (block.block_type === 12 || block.block_type === 13) {
    return {
      ...base,
      type: "list",
      ordered: block.block_type === 13,
      items: [textRuns(block)],
    };
  }
  if (block.block_type === 15 || block.block_type === 19) {
    return { ...base, type: "callout", inlines: textRuns(block) };
  }
  if (block.block_type === 22) return { ...base, type: "divider" };
  if (block.block_type === 27) {
    const media = mediaByBlock.get(block.block_id);
    if (media === undefined) {
      return {
        ...base,
        type: "readonly_source_block",
        sourceVersionId: input.sourceVersionId,
        locator: { kind: "block", blockId: block.block_id },
        sourceBlockType: "image_unavailable",
        sourceUrl: `${input.documentUrl}#${block.block_id}`,
        summary: "飞书图片未能下载，保留只读占位",
        previewDerivativeId: null,
      };
    }
    return {
      ...base,
      type: "image",
      assetVersionId: media.assetVersionId,
      derivativeId: null,
      occurrenceId: media.occurrenceId,
      caption: "",
      alt: "飞书图片",
      fit: "contain",
      slotId: null,
    };
  }
  if (block.block_type === 31) {
    const table = tableFromBlock(block, input.byId);
    return { ...base, type: "table", columns: table.columns, rows: table.rows };
  }
  return {
    ...base,
    type: "readonly_source_block",
    sourceVersionId: input.sourceVersionId,
    locator: { kind: "block", blockId: block.block_id },
    sourceBlockType: `feishu_${block.block_type}`,
    sourceUrl: `${input.documentUrl}#${block.block_id}`,
    summary: textOfFeishuBlock(block).join("") || "未知飞书块，已保留只读占位",
    previewDerivativeId: null,
  };
}

function textRuns(block: FeishuBlock): Array<{ text: string; marks: unknown[] }> {
  const elements = elementsOf(block);
  const runs = elements.map((element) => {
    const textRun = element.text_run;
    if (textRun === null || typeof textRun !== "object") return { text: "", marks: [] };
    const value = textRun as Record<string, unknown>;
    const text = typeof value.content === "string" ? value.content : "";
    const style = value.text_element_style;
    const marks: unknown[] = [];
    if (style !== null && typeof style === "object") {
      const record = style as Record<string, unknown>;
      if (record.bold === true) marks.push("bold");
      if (record.italic === true) marks.push("italic");
      if (record.inline_code === true) marks.push("code");
      const link = record.link;
      if (link !== null && typeof link === "object") {
        const url = (link as Record<string, unknown>).url;
        if (typeof url === "string") marks.push({ type: "link", href: decodeLink(url) });
      }
    }
    return { text, marks };
  }).filter((run) => run.text !== "");
  return runs.length === 0 ? [{ text: " ", marks: [] }] : runs;
}

function elementsOf(block: FeishuBlock): Array<Record<string, unknown>> {
  for (const value of Object.values(block)) {
    if (value === null || typeof value !== "object") continue;
    const elements = (value as Record<string, unknown>).elements;
    if (Array.isArray(elements)) {
      return elements.filter((element): element is Record<string, unknown> =>
        element !== null && typeof element === "object",
      );
    }
  }
  return [];
}

function decodeLink(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tableFromBlock(block: FeishuBlock, byId: Map<string, FeishuBlock>): {
  columns: string[];
  rows: Array<Array<Array<{ text: string; marks: unknown[] }>>>;
} {
  const table = block.table;
  const property = table !== null && typeof table === "object"
    ? (table as Record<string, unknown>).property
    : null;
  const columnSize = property !== null && typeof property === "object"
    ? Number((property as Record<string, unknown>).column_size ?? 0)
    : 0;
  const cells = table !== null && typeof table === "object"
    ? (table as Record<string, unknown>).cells
    : null;
  const cellIds = Array.isArray(cells) ? cells.filter((value): value is string => typeof value === "string") : [];
  if (columnSize <= 0 || cellIds.length === 0) {
    return { columns: ["内容"], rows: [[textRuns(block)]] };
  }
  const cellValues = cellIds.map((cellId) => {
    const cell = byId.get(cellId);
    if (cell === undefined) return [{ text: " ", marks: [] }];
    const children = Array.isArray(cell.children)
      ? cell.children.map((childId) => byId.get(childId)).filter((child): child is FeishuBlock => child !== undefined)
      : [];
    const inlines = children.flatMap(textRuns);
    return inlines.length === 0 ? [{ text: " ", marks: [] }] : inlines;
  });
  const rowCount = Math.ceil(cellValues.length / columnSize);
  const columns = cellValues.slice(0, columnSize).map((cell) => cell.map((inline) => inline.text).join("") || "列");
  const rows = Array.from({ length: Math.max(0, rowCount - 1) }, (_, rowIndex) =>
    cellValues.slice((rowIndex + 1) * columnSize, (rowIndex + 2) * columnSize),
  );
  return { columns, rows };
}
