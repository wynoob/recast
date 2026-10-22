import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ExtractionBudget } from "./budget.js";
import {
  ExtractedDocumentSchema,
  LocalAdapterError,
  PROCESSOR_VERSION,
  resolveLimits,
  type ExtractedDocument,
  type ExtractedMediaResource,
  type ExtractedSection,
  type ExtractionInput,
  type ExtractionWarning,
  type MediaOccurrence,
} from "./contracts.js";
import {
  abortIfNeeded,
  ensureStagingDir,
  isRecord,
  makeId,
  normalizeText,
  oneLine,
  pageContext,
  readHead,
  requireRegularFile,
  sha256File,
  stageFileByHash,
} from "./util.js";

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

interface PageText {
  readonly page: number;
  readonly lines: readonly string[];
}

export async function extractPdf(input: ExtractionInput): Promise<ExtractedDocument> {
  const limits = resolveLimits(input.options);
  const budget = new ExtractionBudget(limits);
  const stagingDir = await ensureStagingDir(input.stagingDir);
  const source = await requireRegularFile(input.sourcePath, limits.maxInputBytes);
  abortIfNeeded(input.signal);
  const head = await readHead(source.absolute, 8);
  if (head.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new LocalAdapterError("UNSUPPORTED_FORMAT", "PDF 文件头不是 %PDF-");
  }

  const originalSha256 = await sha256File(source.absolute, input.signal);
  const bytes = await readFile(source.absolute);
  abortIfNeeded(input.signal);
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });

  try {
    const document = await loadingTask.promise;
    if (document.numPages > limits.maxSections) {
      throw new LocalAdapterError("CAPACITY_EXCEEDED", "PDF 页数超过章节上限", {
        details: { pages: document.numPages, maxSections: limits.maxSections },
      });
    }
    const pages: PageText[] = [];
    const warnings: ExtractionWarning[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      abortIfNeeded(input.signal);
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent({
          includeMarkedContent: false,
          disableNormalization: false,
        });
        const lines = textLines(content.items);
        for (const text of lines) budget.reserveText(text);
        pages.push({ page: pageNumber, lines });
        if (lines.length === 0) {
          warnings.push({
            code: "PAGE_TEXT_EMPTY",
            message: `第 ${pageNumber} 页没有可提取文字，OCR 未配置`,
            sectionId: makeId("sec", pageNumber),
            locator: { kind: "page", page: pageNumber },
          });
        }
      } finally {
        page.cleanup();
      }
    }
    warnings.push({
      code: "OCR_BLOCKED",
      message: "OCR 凭证未配置，扫描页文字不冒充已识别；PDF 文字只来自 pdfjs-dist",
      sectionId: null,
      locator: null,
    });

    const metadataTitle = await document
      .getMetadata()
      .then((meta) => readMetadataTitle(meta.info))
      .catch(() => null);
    if (metadataTitle !== null) budget.reserveText(metadataTitle);
    const title = metadataTitle ?? fallbackTitle(source.fileName);
    const sections: ExtractedSection[] = pages.map((page) => {
      const sectionTitle =
        page.lines[0] === undefined ? `第${page.page}页` : oneLine(page.lines[0], 120);
      return {
        id: makeId("sec", page.page),
        order: page.page,
        title: sectionTitle,
        headingPath: sectionTitle,
        locator: { kind: "page", page: page.page },
        blocks: page.lines.map((text, index) => ({
          id: `${makeId("sec", page.page)}-p${index + 1}`,
          kind: "paragraph" as const,
          text,
          locator: { kind: "page" as const, page: page.page },
        })),
        notes: "",
      };
    });

    const renderPdfPages = input.options?.renderPdfPages ?? true;
    const rendererAvailable = commandExists("pdftoppm");
    const media: ExtractedMediaResource[] = [];
    const occurrences: MediaOccurrence[] = [];
    let pageImagesExtracted = 0;
    if (renderPdfPages) {
      if (document.numPages > limits.maxPageImages) {
        throw new LocalAdapterError("CAPACITY_EXCEEDED", "PDF 页面图数量超过上限", {
          details: { pageCount: document.numPages, maxPageImages: limits.maxPageImages },
        });
      }
      budget.reserveMedia(document.numPages);
    }
    if (renderPdfPages && rendererAvailable) {
      const rendered = await renderPdfPagesToStaging({
        sourcePath: source.absolute,
        stagingDir,
        pageCount: document.numPages,
        signal: input.signal,
      });
      if (!rendered.ok) {
        warnings.push({
          code: "PAGE_RENDER_UNAVAILABLE",
          message: rendered.message,
          sectionId: null,
          locator: null,
        });
      } else {
        try {
          for (const page of pages) {
            abortIfNeeded(input.signal);
            const imagePath = rendered.pageFiles.get(page.page);
            if (imagePath === undefined) continue;
            const hash = await sha256File(imagePath, input.signal);
            const fileInfo = await stageFileByHash({
              sourcePath: imagePath,
              stagingDir,
              extension: ".png",
              signal: input.signal,
              hash,
            });
            const id = `media-${media.length + 1}`;
            media.push({
              id,
              sourceInternalPath: `pdf/page/${page.page}`,
              status: "extracted",
              mediaKind: "image",
              mime: "image/png",
              stagedPath: fileInfo.stagedPath,
              sha256: fileInfo.sha256,
              bytes: fileInfo.bytes,
            });
            const context = pageContext(page.lines);
            occurrences.push({
              id: makeId("occ", occurrences.length + 1),
              mediaId: id,
              sectionId: makeId("sec", page.page),
              locator: { kind: "page", page: page.page },
              headingPath: sections[page.page - 1]?.headingPath ?? `第${page.page}页`,
              beforeText: context.beforeText,
              afterText: context.afterText,
              mediaStatus: "extracted",
            });
            pageImagesExtracted += 1;
          }
        } finally {
          await rm(rendered.renderDir, { recursive: true, force: true });
        }
        if (pageImagesExtracted < document.numPages) {
          warnings.push({
            code: "PAGE_RENDER_UNAVAILABLE",
            message: "PDF 页面图只生成了一部分，未生成的页保持 partial",
            sectionId: null,
            locator: null,
          });
        }
      }
    } else {
      warnings.push({
        code: renderPdfPages ? "PAGE_RENDER_UNAVAILABLE" : "PAGE_RENDER_UNAVAILABLE",
        message: renderPdfPages
          ? "本机没有可用的 PDF 页面渲染器，页面图未生成"
          : "调用方关闭了 PDF 页面图生成",
        sectionId: null,
        locator: null,
      });
    }

    const hasText = sections.some((section) => section.blocks.length > 0);
    const partial =
      !hasText ||
      pageImagesExtracted < document.numPages ||
      !renderPdfPages ||
      !rendererAvailable ||
      warnings.some((warning) => warning.code === "PAGE_TEXT_EMPTY");
    const result = {
      schemaVersion: 1 as const,
      format: "pdf" as const,
      processorVersion: PROCESSOR_VERSION.pdf,
      originalSha256,
      sourceFileName: source.fileName,
      sourceBytes: source.bytes,
      title,
      pageCount: document.numPages,
      sections,
      media,
      occurrences,
      warnings,
      status: !hasText && media.length === 0 ? ("blocked" as const) : partial ? ("partial" as const) : ("complete" as const),
      capabilities: {
        pageImages: renderPdfPages
          ? rendererAvailable && pageImagesExtracted > 0
            ? ("extracted" as const)
            : ("unavailable" as const)
          : ("disabled" as const),
        libreOffice: "not_applicable" as const,
        ocr: "blocked" as const,
        renderer: rendererAvailable ? "pdftoppm" : null,
      },
    };
    return ExtractedDocumentSchema.parse(result);
  } catch (error: unknown) {
    if (error instanceof LocalAdapterError || isAbortError(error)) throw error;
    throw new LocalAdapterError("SOURCE_UNREADABLE", "PDF 解析失败", { cause: error });
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

function textLines(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (!isRecord(item)) continue;
    const text = typeof item["str"] === "string" ? item["str"] : "";
    current += text;
    if (item["hasEOL"] === true) {
      const normalized = normalizeText(current);
      if (normalized !== "") lines.push(normalized);
      current = "";
    }
  }
  const last = normalizeText(current);
  if (last !== "") lines.push(last);
  return lines;
}

function readMetadataTitle(info: unknown): string | null {
  if (!isRecord(info)) return null;
  const title = info["Title"];
  if (typeof title !== "string") return null;
  const normalized = normalizeText(title);
  return normalized === "" ? null : oneLine(normalized, 500);
}

function fallbackTitle(fileName: string): string {
  const title = fileName.replace(/\.[^.]+$/u, "").trim();
  return title === "" ? "未命名 PDF" : oneLine(title, 500);
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

async function renderPdfPagesToStaging(args: {
  readonly sourcePath: string;
  readonly stagingDir: string;
  readonly pageCount: number;
  readonly signal: AbortSignal | undefined;
}): Promise<
  | {
      readonly ok: true;
      readonly pageFiles: ReadonlyMap<number, string>;
      readonly renderDir: string;
    }
  | { readonly ok: false; readonly message: string }
> {
  const renderDir = await mkdtemp(join(args.stagingDir, ".pdf-render-"));
  const prefix = join(renderDir, "page");
  const lastPage = args.pageCount;
  try {
    const result = await runProcess(
      "pdftoppm",
      ["-png", "-r", "96", "-f", "1", "-l", String(lastPage), args.sourcePath, prefix],
      args.signal,
    );
    if (!result.ok) {
      await rm(renderDir, { recursive: true, force: true });
      return { ok: false, message: `pdftoppm 渲染失败：${result.message}` };
    }
    const files = new Map<number, string>();
    const names = await readdir(renderDir);
    for (const name of names) {
      const match = /^page-(\d+)\.png$/u.exec(name);
      if (match === null) continue;
      const page = Number(match[1]);
      if (Number.isInteger(page)) files.set(page, join(renderDir, name));
    }
    if (files.size === 0) {
      await rm(renderDir, { recursive: true, force: true });
      return { ok: false, message: "pdftoppm 没有生成页面图" };
    }
    return { ok: true, pageFiles: files, renderDir };
  } catch (error: unknown) {
    await rm(renderDir, { recursive: true, force: true });
    throw error;
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      signal,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (isAbortError(error)) reject(error);
      else resolve({ ok: false, message: error.message });
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: stderr.trim() || `退出码 ${String(code)}` });
    });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (isRecord(error) && error["name"] === "AbortError")
  );
}

