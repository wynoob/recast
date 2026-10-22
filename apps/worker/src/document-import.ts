import { createHash } from "node:crypto";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  DocumentChunkDraftSchema,
  DocumentExtractionDraftSchema,
  DocumentOccurrenceDraftSchema,
  DocumentSectionDraftSchema,
  type DocumentCapabilities,
  type DocumentExtractionDraft,
  type DocumentOccurrenceDraft,
  type DocumentSectionDraft,
  type DocumentWarning,
  type ImportManifestItem,
  type StagedDocumentMedia,
  type StagedFile,
} from "@dmall/contracts";
import {
  extractPdf,
  extractPptx,
  extractStaticHtml,
  LocalAdapterError,
  openZip,
  resolveLimits,
  type ExtractedDocument,
} from "@dmall/local-adapters";
import { RestrictedRoot, RestrictedFileError } from "@dmall/storage";
import { chunkSections, ChunkSectionsInputSchema } from "@dmall/search";
import { titleFromFileName } from "@dmall/domain";
import { parseMarkdownDocument } from "./markdown.js";
import { WorkerTaskError } from "./task-error.js";

const COPY_BUFFER = 1024 * 1024;
const MEDIA_BATCH_SIZE = 32;

export interface DocumentProcessResult {
  item: Extract<
    import("@dmall/contracts").ImportItemResult,
    { state: "committed" }
  >;
  stagedFiles: StagedFile[];
  mediaBatches: StagedDocumentMedia[][];
}

export async function processDocumentItem(input: {
  item: ImportManifestItem;
  originalPath: string;
  itemDirectory: string;
  workspace: string;
  signal: AbortSignal;
  knownFiles: readonly string[];
  originalSha256: string;
  originalBytes: number;
  originalMime: string;
  originalWorkspacePath: string;
}): Promise<DocumentProcessResult> {
  try {
    if (input.item.kind === "markdown") {
      return await processMarkdown(input);
    }
    if (input.item.kind === "html") {
      return await processHtmlFile(input);
    }
    if (input.item.kind === "html_zip") {
      return await processHtmlArchive(input);
    }
    if (input.item.kind === "pdf") {
      return await processAdapterDocument(input, "pdf");
    }
    if (input.item.kind === "pptx") {
      return await processAdapterDocument(input, "pptx");
    }
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "文档格式不在本地导入范围");
  } catch (error) {
    if (error instanceof LocalAdapterError) {
      throw new WorkerTaskError(error.code, error.message, error.retryable);
    }
    if (error instanceof WorkerTaskError || error instanceof RestrictedFileError) throw error;
    throw new WorkerTaskError(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "文档抽取失败",
      true,
    );
  }
}

async function processMarkdown(input: {
  item: ImportManifestItem;
  originalPath: string;
  itemDirectory: string;
  workspace: string;
  signal: AbortSignal;
  knownFiles: readonly string[];
  originalSha256: string;
  originalBytes: number;
  originalMime: string;
  originalWorkspacePath: string;
}): Promise<DocumentProcessResult> {
  const text = await readUtf8(input.originalPath);
  const parsed = await parseMarkdownDocument({
    text,
    rootPath: input.item.rootPath,
    relativePath: input.item.relativePath,
    knownFiles: input.knownFiles,
  });
  const warnings: DocumentWarning[] = parsed.occurrences
    .filter((occurrence) => occurrence.mediaStatus !== "available")
    .map((occurrence) => ({
      code: occurrence.errorCode ?? "MISSING_DEPENDENCY",
      message: `Markdown 图片未取得：${occurrence.locator.rawTarget}`,
      sectionAdapterId: sectionForMarkdownLine(parsed.sections, occurrence.locator.line)?.adapterId ?? null,
      locator: occurrence.locator,
    }));
  const occurrences = parsed.occurrences.map((occurrence) =>
    DocumentOccurrenceDraftSchema.parse({
      adapterId: `md-occurrence-${occurrence.locator.ordinal}`,
      mediaAdapterId: occurrence.resolvedRelativePath,
      sectionAdapterId:
        sectionForMarkdownLine(parsed.sections, occurrence.locator.line)?.adapterId ??
        parsed.sections[0]?.adapterId ??
        "md-section-0",
      locator: occurrence.locator,
      headingPath: occurrence.headingPath,
      beforeText: occurrence.beforeText,
      afterText: occurrence.afterText,
      mediaStatus: occurrence.mediaStatus,
      errorCode: occurrence.errorCode,
    }),
  );
  const document = draftDocument({
    format: "markdown",
    processorVersion: "dcw-markdown/2",
    title: parsed.title,
    pageCount: null,
    status: warnings.length === 0 ? "complete" : "partial",
    capabilities: notApplicableCapabilities(),
    warnings,
    sections: parsed.sections,
    occurrences,
    plannedSourceVersionId: input.item.plannedSourceVersionId,
  });
  return committedDocument(input, document, []);
}

async function processHtmlFile(input: {
  item: ImportManifestItem;
  originalPath: string;
  itemDirectory: string;
  workspace: string;
  signal: AbortSignal;
  originalSha256: string;
  originalBytes: number;
  originalMime: string;
  originalWorkspacePath: string;
}): Promise<DocumentProcessResult> {
  const isolatedRoot = join(input.itemDirectory, "isolated-html");
  const sourceRelativePath = safeDependencyPath("", input.item.relativePath);
  if (sourceRelativePath === null) {
    throw new WorkerTaskError("PATH_NOT_ALLOWED", "HTML 源路径越出导入隔离目录");
  }
  const isolatedSource = resolve(isolatedRoot, ...sourceRelativePath.split("/"));
  const relativeSource = relative(isolatedRoot, isolatedSource);
  if (relativeSource.startsWith("..") || isAbsolute(relativeSource)) {
    throw new WorkerTaskError("PATH_NOT_ALLOWED", "HTML 源路径越出导入隔离目录");
  }
  await mkdir(dirname(isolatedSource), { recursive: true, mode: 0o700 });
  await copyFile(input.originalPath, isolatedSource);
  const firstStaging = join(input.itemDirectory, "html-probe");
  const first = await extractStaticHtml({
    sourcePath: isolatedSource,
    stagingDir: firstStaging,
    signal: input.signal,
  });
  await stageAvailableHtmlDependencies(input, first, isolatedRoot);
  await rm(firstStaging, { recursive: true, force: true });
  const stagingDir = join(input.itemDirectory, "extracted");
  const extracted = await extractStaticHtml({
    sourcePath: isolatedSource,
    stagingDir,
    signal: input.signal,
  });
  return adapterResult(input, extracted, "html", "dcw-static-html/2", stagingDir);
}

async function processHtmlArchive(input: {
  item: ImportManifestItem;
  originalPath: string;
  itemDirectory: string;
  workspace: string;
  signal: AbortSignal;
  originalSha256: string;
  originalBytes: number;
  originalMime: string;
  originalWorkspacePath: string;
}): Promise<DocumentProcessResult> {
  if (/\.dcp\.zip$/iu.test(input.item.relativePath)) {
    throw new WorkerTaskError(
      "UNSUPPORTED_FORMAT",
      "项目包 .dcp.zip 不能作为 HTML ZIP 导入",
    );
  }
  const zipStaging = join(input.itemDirectory, "zip-open");
  const limits = resolveLimits({});
  const archive = await openZip({
    sourcePath: input.originalPath,
    inputBytes: input.item.bytes,
    stagingDir: zipStaging,
    signal: input.signal,
    limits,
    select: () => true,
  });
  try {
    const isolatedRoot = join(input.itemDirectory, "isolated-html");
    await mkdir(isolatedRoot, { recursive: true, mode: 0o700 });
    for (const entry of archive.entries.values()) {
      const destination = resolve(isolatedRoot, ...entry.name.split("/"));
      const relativePath = relative(isolatedRoot, destination);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new WorkerTaskError("PATH_NOT_ALLOWED", "ZIP 条目越出隔离目录");
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(entry.tempPath, destination);
    }
    const htmlEntries = [...archive.entries.keys()]
      .filter((name) => /\.html?$/iu.test(name))
      .sort((left, right) => {
        const leftIndex = basename(left).toLowerCase() === "index.html" ? 0 : 1;
        const rightIndex = basename(right).toLowerCase() === "index.html" ? 0 : 1;
        return leftIndex - rightIndex || left.length - right.length || left.localeCompare(right);
      });
    const htmlEntry = htmlEntries[0];
    if (htmlEntry === undefined) {
      throw new WorkerTaskError("UNSUPPORTED_FORMAT", "HTML ZIP 中没有 .html 或 .htm 入口");
    }
    const sourcePath = resolve(isolatedRoot, ...htmlEntry.split("/"));
    const extracted = await extractStaticHtml({
      sourcePath,
      stagingDir: join(input.itemDirectory, "extracted"),
      signal: input.signal,
      options: { limits },
    });
    return adapterResult(
      input,
      extracted,
      "html_zip",
      "dcw-html-zip/2",
      join(input.itemDirectory, "extracted"),
    );
  } finally {
    await archive.cleanup();
  }
}

async function processAdapterDocument(
  input: {
    item: ImportManifestItem;
    originalPath: string;
    itemDirectory: string;
    workspace: string;
    signal: AbortSignal;
    originalSha256: string;
    originalBytes: number;
    originalMime: string;
    originalWorkspacePath: string;
  },
  format: "pdf" | "pptx",
): Promise<DocumentProcessResult> {
  const stagingDir = join(input.itemDirectory, "extracted");
  const extracted =
    format === "pdf"
      ? await extractPdf({
          sourcePath: input.originalPath,
          stagingDir,
          signal: input.signal,
        })
      : await extractPptx({
          sourcePath: input.originalPath,
          stagingDir,
          signal: input.signal,
        });
  return adapterResult(
    input,
    extracted,
    format,
    format === "pdf" ? "dcw-pdf/2" : "dcw-pptx/2",
    stagingDir,
  );
}

async function adapterResult(
  input: {
    item: ImportManifestItem;
    itemDirectory: string;
    workspace: string;
    originalSha256: string;
    originalBytes: number;
    originalMime: string;
    originalWorkspacePath: string;
  },
  extracted: ExtractedDocument,
  format: "html" | "html_zip" | "pdf" | "pptx",
  processorVersion: string,
  stagingDir: string,
): Promise<DocumentProcessResult> {
  const sections = extracted.sections.map((section) => {
    const blocks =
      section.blocks[0]?.text === section.title
        ? section.blocks.slice(1)
        : section.blocks;
    return DocumentSectionDraftSchema.parse({
      adapterId: section.id,
      ordinal: section.order,
      title: section.title,
      headingPath: section.headingPath,
      text: blocks.map((block) => block.text).join("\n\n"),
      locator: section.locator,
      blocks: blocks.map((block, index) => ({
        adapterId: block.id,
        ordinal: index + 1,
        text: block.text,
        locator: block.locator,
      })),
      notes: section.notes,
    });
  });
  const mediaById = new Map(extracted.media.map((media) => [media.id, media]));
  const media: StagedDocumentMedia[] = [];
  for (const resource of extracted.media) {
    if (resource.status !== "extracted") continue;
    media.push({
      adapterId: resource.id,
      mediaKind: resource.mediaKind,
      mediaStatus: "extracted",
      sourceInternalPath: resource.sourceInternalPath,
      relativePath: workspaceRelative(
        input.workspace,
        resolve(stagingDir, resource.stagedPath),
      ),
      sha256: resource.sha256,
      bytes: resource.bytes,
      mime: resource.mime,
      role: format === "pdf" ? "page_image" : "document_media",
    });
  }
  const occurrences: DocumentOccurrenceDraft[] = extracted.occurrences.map((occurrence) => {
    const mediaResource = mediaById.get(occurrence.mediaId);
    const available =
      occurrence.mediaStatus === "extracted" &&
      mediaResource?.status === "extracted";
    return DocumentOccurrenceDraftSchema.parse({
      adapterId: occurrence.id,
      mediaAdapterId: occurrence.mediaId,
      sectionAdapterId: occurrence.sectionId,
      locator: occurrence.locator,
      headingPath: occurrence.headingPath,
      beforeText: occurrence.beforeText,
      afterText: occurrence.afterText,
      mediaStatus: available ? "available" : mediaResource?.status === "missing" ? "missing" : "unsupported",
      errorCode: available
        ? null
        : mediaResource?.status === "missing"
          ? mediaResource.errorCode
          : "MISSING_DEPENDENCY",
    });
  });
  const warnings: DocumentWarning[] = extracted.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    sectionAdapterId: warning.sectionId,
    locator: warning.locator,
    ...(warning.details === undefined ? {} : { details: warning.details }),
  }));
  const extractedTitle =
    /^(?:presentation|pptxgenjs presentation)$/iu.test(extracted.title)
      ? basename(input.item.relativePath).replace(/\.[^.]+$/u, "")
      : extracted.title;
  const document = draftDocument({
    format,
    processorVersion,
    title: extractedTitle,
    pageCount: extracted.pageCount,
    status: extracted.status,
    capabilities: extracted.capabilities,
    warnings,
    sections,
    occurrences,
    plannedSourceVersionId: input.item.plannedSourceVersionId,
  });
  return committedDocument(input, document, media);
}

function committedDocument(
  input: {
    item: ImportManifestItem;
    workspace: string;
    originalSha256: string;
    originalBytes: number;
    originalMime: string;
    originalWorkspacePath: string;
  },
  document: DocumentExtractionDraft,
  media: StagedDocumentMedia[],
): DocumentProcessResult {
  const mediaBatches: StagedDocumentMedia[][] = [];
  for (let index = 0; index < media.length; index += MEDIA_BATCH_SIZE) {
    mediaBatches.push(media.slice(index, index + MEDIA_BATCH_SIZE));
  }
  const docWithBatches = DocumentExtractionDraftSchema.parse({
    ...document,
    mediaCount: media.length,
    mediaBatchCount: mediaBatches.length,
  });
  return {
    item: {
      state: "committed",
      scanItemId: input.item.scanItemId,
      relativePath: input.item.relativePath,
      kind: "document",
      title: [...docWithBatches.title].slice(0, 200).join("") || titleFromFileName(basename(input.item.relativePath)),
      sha256: input.originalSha256,
      bytes: input.originalBytes,
      mime: input.originalMime,
      processorVersions: { document: docWithBatches.processorVersion },
      probe: null,
      markdownOccurrences: [],
      document: docWithBatches,
    },
    stagedFiles: [
      {
        role: "original",
        relativePath: input.originalWorkspacePath,
        sha256: input.originalSha256,
        bytes: input.originalBytes,
        mime: input.originalMime,
      },
    ],
    mediaBatches,
  };
}

function draftDocument(input: {
  format: "markdown" | "html" | "html_zip" | "pdf" | "pptx";
  processorVersion: string;
  title: string;
  pageCount: number | null;
  status: "complete" | "partial" | "blocked";
  capabilities: DocumentCapabilities;
  warnings: DocumentWarning[];
  sections: DocumentSectionDraft[];
  occurrences: DocumentOccurrenceDraft[];
  plannedSourceVersionId: string;
}): DocumentExtractionDraft {
  const chunkSectionsInput = ChunkSectionsInputSchema.parse(
    input.sections.map((section) => ({
      sectionId: section.adapterId,
      title: section.title,
      page: section.locator.kind === "page" ? section.locator.page : null,
      sourceVersionId: input.plannedSourceVersionId,
      tags: [],
      metadata: {
        merchantId: null,
        mediaKind: "document",
        recordDate: null,
        effectiveFrom: null,
        effectiveTo: null,
        audience: [],
        functions: [],
        obsolete: false,
        availability: "available",
      },
      blocks: section.blocks.map((block) => ({
        kind: "text",
        blockId: block.adapterId,
        text: block.text,
      })),
    })),
  );
  const chunks = chunkSections(chunkSectionsInput, { makeChunkRefId: uuidFromSeed });
  const chunkDrafts = chunks.map((chunk) =>
    DocumentChunkDraftSchema.parse({
      sectionAdapterId: chunk.sectionId,
      chunkId: chunk.candidate.refId,
      chunkKind: chunk.chunkKind,
      text: chunk.candidate.text,
      title: chunk.candidate.title,
      tags: chunk.candidate.tags,
      merchantId: chunk.candidate.merchantId,
      mediaKind: chunk.candidate.mediaKind,
      recordDate: chunk.candidate.recordDate,
      effectiveFrom: chunk.candidate.effectiveFrom,
      effectiveTo: chunk.candidate.effectiveTo,
      audience: chunk.candidate.audience,
      functions: chunk.candidate.functions,
      obsolete: chunk.candidate.obsolete,
      availability: chunk.candidate.availability,
      locationKey: chunk.candidate.locationKey,
      contentHash: chunk.contentHash,
      blockAdapterIds: chunk.blockIds,
      overlapChars: chunk.overlapChars,
    }),
  );
  return DocumentExtractionDraftSchema.parse({
    format: input.format,
    processorVersion: input.processorVersion,
    title: input.title,
    pageCount: input.pageCount,
    status: input.status,
    capabilities: input.capabilities,
    warnings: input.warnings,
    sections: input.sections,
    occurrences: input.occurrences,
    chunkDrafts,
    mediaCount: 0,
    mediaBatchCount: 0,
    extractionSnapshot: {
      format: input.format,
      processorVersion: input.processorVersion,
      title: input.title,
      pageCount: input.pageCount,
      status: input.status,
      capabilities: input.capabilities,
      warnings: input.warnings,
    },
  });
}

async function stageAvailableHtmlDependencies(
  input: {
    item: ImportManifestItem;
    originalPath: string;
  },
  extracted: ExtractedDocument,
  isolatedRoot: string,
): Promise<void> {
  const boundary = await RestrictedRoot.capture(input.item.rootPath);
  const htmlDirectory = posix.dirname(input.item.relativePath);
  for (const resource of extracted.media) {
    if (
      resource.status !== "missing" ||
      resource.errorCode !== "MISSING_DEPENDENCY"
    ) {
      continue;
    }
    const relativePath = safeDependencyPath(htmlDirectory, resource.sourceInternalPath);
    if (relativePath === null) continue;
    const destination = resolve(isolatedRoot, ...relativePath.split("/"));
    const rel = relative(isolatedRoot, destination);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await copyRestrictedFile(boundary, relativePath, destination);
    } catch {
    }
  }
}

function safeDependencyPath(directory: string, sourceInternalPath: string): string | null {
  if (
    /^(?:https?:|mailto:|ftp:|data:|javascript:)/iu.test(sourceInternalPath) ||
    sourceInternalPath.startsWith("//") ||
    sourceInternalPath.includes("\\") ||
    isAbsolute(sourceInternalPath)
  ) {
    return null;
  }
  const normalized = posix.normalize(posix.join(directory, sourceInternalPath));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  return normalized;
}

async function copyRestrictedFile(
  boundary: RestrictedRoot,
  relativePath: string,
  destination: string,
): Promise<void> {
  await boundary.withFile({
    path: relativePath,
    read: async ({ handle, verify }) => {
      const target = await open(destination, "wx", 0o600);
      const buffer = Buffer.alloc(COPY_BUFFER);
      try {
        let position = 0;
        while (true) {
          await verify();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          await verify();
          if (bytesRead === 0) break;
          await target.write(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        await target.sync();
      } finally {
        await target.close();
      }
      return undefined;
    },
  });
}

function sectionForMarkdownLine(
  sections: readonly DocumentSectionDraft[],
  line: number,
): DocumentSectionDraft | null {
  let selected: DocumentSectionDraft | null = null;
  for (const section of sections) {
    if (section.locator.kind !== "markdown_text" || section.locator.line > line) continue;
    selected = section;
  }
  return selected ?? sections[0] ?? null;
}

function notApplicableCapabilities(): DocumentCapabilities {
  return {
    pageImages: "not_applicable",
    libreOffice: "not_applicable",
    ocr: "blocked",
    renderer: null,
  };
}

function workspaceRelative(workspace: string, path: string): string {
  const absolute = resolve(path);
  const rel = relative(resolve(workspace), absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkerTaskError("PATH_NOT_ALLOWED", "抽取产物越出任务工作目录");
  }
  return rel.split("\\").join("/");
}

function uuidFromSeed(seedHash: string): string {
  const hex = createHash("sha256").update(seedHash).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function readUtf8(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = await handle.readFile();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new WorkerTaskError("SOURCE_UNREADABLE", "Markdown 不是有效 UTF-8");
    }
  } finally {
    await handle.close();
  }
}

