import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { parseSafeXml as parseXml } from "./xml.js";
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
  type ExtractionLimits,
  type ExtractionWarning,
  type MediaOccurrence,
} from "./contracts.js";
import { openZip, type ZipArchive } from "./zip.js";
import {
  abortIfNeeded,
  attribute,
  asRecordArray,
  child,
  collectText,
  detectMime,
  ensureStagingDir,
  extensionForPath,
  isRecord,
  makeId,
  normalizeExtension,
  normalizeText,
  oneLine,
  pageContext,
  readHead,
  requireRegularFile,
  sha256File,
  stageFileByHash,
} from "./util.js";

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  readonly packagePath: string | null;
}

interface PptxMediaRef {
  readonly key: string;
  readonly sourceInternalPath: string;
  readonly external: boolean;
  readonly packagePath: string | null;
}

export async function extractPptx(input: ExtractionInput): Promise<ExtractedDocument> {
  const limits = resolveLimits(input.options);
  const stagingDir = await ensureStagingDir(input.stagingDir);
  const source = await requireRegularFile(input.sourcePath, limits.maxInputBytes);
  abortIfNeeded(input.signal);
  const head = await readHead(source.absolute, 4);
  if (head.toString("ascii") !== "PK\u0003\u0004") {
    throw new LocalAdapterError("UNSUPPORTED_FORMAT", "PPTX 必须是 ZIP 容器");
  }

  const originalSha256 = await sha256File(source.absolute, input.signal);
  const archive = await openZip({
    sourcePath: source.absolute,
    inputBytes: source.bytes,
    stagingDir,
    signal: input.signal,
    limits,
    select: isSelectedPptxPart,
  });

  try {
    return await buildPptxDocument({
      archive,
      sourceName: source.fileName,
      sourceBytes: source.bytes,
      originalSha256,
      stagingDir,
      limits,
      signal: input.signal,
    });
  } finally {
    await archive.cleanup();
  }
}

async function buildPptxDocument(args: {
  readonly archive: ZipArchive;
  readonly sourceName: string;
  readonly sourceBytes: number;
  readonly originalSha256: string;
  readonly stagingDir: string;
  readonly limits: ExtractionLimits;
  readonly signal: AbortSignal | undefined;
}): Promise<ExtractedDocument> {
  const presentation = args.archive.entry("ppt/presentation.xml");
  const presentationRels = args.archive.entry("ppt/_rels/presentation.xml.rels");
  if (presentation === null || presentationRels === null) {
    throw new LocalAdapterError("SOURCE_UNREADABLE", "PPTX 缺少演示文稿或关系文件");
  }

  const presentationXml = parseXml(args.archive.readText("ppt/presentation.xml", args.signal));
  const relationships = parseRelationships(
    args.archive.readText("ppt/_rels/presentation.xml.rels", args.signal),
    "ppt/presentation.xml",
  );
  const presentationRoot = child(presentationXml, "p:presentation");
  const slideList = child(presentationRoot, "p:sldIdLst");
  const slideIds = asRecordArray(child(slideList, "p:sldId"));
  if (slideIds.length === 0) {
    throw new LocalAdapterError("SOURCE_UNREADABLE", "PPTX 中没有按顺序声明的页面");
  }

  const budget = new ExtractionBudget(args.limits);
  const documentName = documentTitle(args.archive);
  if (documentName !== null) budget.reserveText(documentName);
  const sections: ExtractedSection[] = [];
  const occurrences: MediaOccurrence[] = [];
  const warnings: ExtractionWarning[] = [];
  const mediaIds = new Map<string, string>();
  const mediaOrder: string[] = [];
  let occurrenceIndex = 0;

  for (const [index, slideId] of slideIds.entries()) {
    abortIfNeeded(args.signal);
    const page = index + 1;
    const sectionId = makeId("sec", page);
    const relationId = attribute(slideId, "@_r:id");
    const title = relationId === null ? null : relationships.get(relationId) ?? null;
    const slidePart = title?.packagePath ?? null;
    const fallbackTitle = `第${page}页`;

    if (slidePart === null || !args.archive.has(slidePart)) {
      const section: ExtractedSection = {
        id: sectionId,
        order: page,
        title: fallbackTitle,
        headingPath: fallbackTitle,
        locator: { kind: "page", page },
        blocks: [],
        notes: "",
      };
      sections.push(section);
      warnings.push({
        code: "RELATIONSHIP_MISSING",
        message: `第 ${page} 页的 slide 关系缺失或目标不存在`,
        sectionId,
        locator: { kind: "page", page },
      });
      continue;
    }

    const slideXml = parseXml(args.archive.readText(slidePart, args.signal));
    const paragraphs = extractParagraphs(slideXml);
    for (const text of paragraphs) budget.reserveText(text);
    const sectionTitle = paragraphs[0] === undefined ? fallbackTitle : oneLine(paragraphs[0], 120);
    const slideRelationships = parseRelationshipsFromArchive(args.archive, slidePart, args.signal);
    const notes = readNotes(args.archive, slideRelationships, page, warnings, args.signal);
    budget.reserveText(notes);
    const mediaRefs = extractMediaRefs(slideXml, slideRelationships, args.archive);

    for (const ref of mediaRefs) {
      if (!mediaIds.has(ref.key)) {
        mediaIds.set(ref.key, `media-${mediaIds.size + 1}`);
        mediaOrder.push(ref.key);
      }
      occurrenceIndex += 1;
      const context = pageContext(paragraphs);
      occurrences.push({
        id: makeId("occ", occurrenceIndex),
        mediaId: mediaIds.get(ref.key) ?? "media-1",
        sectionId,
        locator: { kind: "page", page },
        headingPath: sectionTitle,
        beforeText: context.beforeText,
        afterText: context.afterText,
        mediaStatus: ref.packagePath !== null && args.archive.has(ref.packagePath) ? "extracted" : "missing",
      });
    }

    if (paragraphs.length === 0) {
      warnings.push({
        code: "PAGE_TEXT_EMPTY",
        message: `第 ${page} 页没有 XML 文字，OCR 未配置，不能冒充已识别`,
        sectionId,
        locator: { kind: "page", page },
      });
    }

    sections.push({
      id: sectionId,
      order: page,
      title: sectionTitle,
      headingPath: sectionTitle,
      locator: { kind: "page", page },
      blocks: paragraphs.map((text, paragraphIndex) => ({
        id: `${sectionId}-p${paragraphIndex + 1}`,
        kind: "paragraph" as const,
        text,
        locator: { kind: "page" as const, page },
      })),
      notes,
    });
  }

  if (sections.length > args.limits.maxSections) {
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "PPTX 页数超过章节上限", {
      details: { sections: sections.length, maxSections: args.limits.maxSections },
    });
  }

  const mediaResources = await buildMediaResources({
    archive: args.archive,
    stagingDir: args.stagingDir,
    budget,
    signal: args.signal,
    mediaIds,
    mediaOrder,
    warnings,
  });

  for (const ref of allMediaArchivePaths(args.archive)) {
    if (!mediaIds.has(`path:${ref}`)) {
      warnings.push({
        code: "UNBOUND_MEDIA",
        message: `媒体文件没有找到页关系：${ref}`,
        sectionId: null,
        locator: null,
        details: { sourceInternalPath: ref },
      });
    }
  }

  const title = documentName ?? fallbackDocumentTitle(args.sourceName);
  const libreOffice = commandExists("soffice") || commandExists("libreoffice");
  warnings.push({
    code: libreOffice ? "PAGE_RENDER_UNAVAILABLE" : "LIBREOFFICE_UNAVAILABLE",
    message: libreOffice
      ? "本模块不执行 LibreOffice 页渲染；整页预览未生成"
      : "未找到 LibreOffice；PPTX 整页预览未生成，文字和媒体关系仍按 XML 提取",
    sectionId: null,
    locator: null,
    details: { libreOffice },
  });
  for (const section of sections) {
    if (section.blocks.length === 0) {
      warnings.push({
        code: "OCR_BLOCKED",
        message: `第 ${section.order} 页没有可读 XML 文字，OCR 未配置`,
        sectionId: section.id,
        locator: { kind: "page", page: section.order },
      });
    }
  }

  const result = {
    schemaVersion: 1 as const,
    format: "pptx" as const,
    processorVersion: PROCESSOR_VERSION.pptx,
    originalSha256: args.originalSha256,
    sourceFileName: args.sourceName,
    sourceBytes: args.sourceBytes,
    title: oneLine(title, 500),
    pageCount: sections.length,
    sections,
    media: mediaResources,
    occurrences,
    warnings,
    status: "partial" as const,
    capabilities: {
      pageImages: "unavailable" as const,
      libreOffice: libreOffice ? ("available" as const) : ("unavailable" as const),
      ocr: "blocked" as const,
      renderer: null,
    },
  };

  return ExtractedDocumentSchema.parse(result);
}

async function buildMediaResources(args: {
  readonly archive: ZipArchive;
  readonly stagingDir: string;
  readonly budget: ExtractionBudget;
  readonly signal: AbortSignal | undefined;
  readonly mediaIds: ReadonlyMap<string, string>;
  readonly mediaOrder: readonly string[];
  readonly warnings: ExtractionWarning[];
}): Promise<ExtractedMediaResource[]> {
  const resources: ExtractedMediaResource[] = [];
  const allPaths = new Set(allMediaArchivePaths(args.archive));
  const unboundPaths = [...allPaths].filter(path => !args.mediaIds.has(`path:${path}`));
  args.budget.reserveMedia(args.mediaOrder.length + unboundPaths.length);
  const keys = [...args.mediaOrder, ...unboundPaths.map(path => `path:${path}`)];
  for (const key of keys) {
    abortIfNeeded(args.signal);
    const id = args.mediaIds.get(key) ?? `media-${args.mediaIds.size + resources.length + 1}`;

    if (key.startsWith("external:")) {
      const target = key.slice("external:".length);
      resources.push({
        id,
        sourceInternalPath: target,
        status: "missing",
        mediaKind: "unknown",
        mime: null,
        errorCode: "EXTERNAL_LINK_BLOCKED",
        message: "外部媒体链接未访问，保留 missing 位置",
      });
      args.warnings.push({
        code: "EXTERNAL_LINK_BLOCKED",
        message: `未访问 PPTX 外部媒体链接 ${target}`,
        sectionId: null,
        locator: null,
      });
      continue;
    }

    const path = key.slice("path:".length);
    const entry = args.archive.entry(path);
    if (entry === null) {
      resources.push({
        id,
        sourceInternalPath: path,
        status: "missing",
        mediaKind: "unknown",
        mime: null,
        errorCode: "MISSING_DEPENDENCY",
        message: "关系指向的媒体文件不在 ZIP 中",
      });
      args.warnings.push({
        code: "MISSING_DEPENDENCY",
        message: `缺少 PPTX 媒体 ${path}`,
        sectionId: null,
        locator: null,
      });
      continue;
    }

    const head = await readHead(entry.tempPath, 512);
    const detected = detectMime(head, path);
    if (detected.mime === "application/octet-stream") {
      args.warnings.push({
        code: "UNSUPPORTED_MEDIA",
        message: `媒体类型未识别，按原始字节保存：${path}`,
        sectionId: null,
        locator: null,
      });
    }
    const staged = await stageFileByHash({
      sourcePath: entry.tempPath,
      stagingDir: args.stagingDir,
      extension: extensionForPath(path) || extensionForMime(detected.mime),
      signal: args.signal,
      hash: entry.sha256,
      bytes: entry.bytes,
    });
    resources.push({
      id,
      sourceInternalPath: path,
      status: "extracted",
      mediaKind: detected.mediaKind,
      mime: detected.mime,
      stagedPath: staged.stagedPath,
      sha256: staged.sha256,
      bytes: staged.bytes,
    });
  }

  return resources;
}

function parseRelationshipsFromArchive(
  archive: ZipArchive,
  partPath: string,
  signal: AbortSignal | undefined,
): ReadonlyMap<string, Relationship> {
  const relationPart = posix.join(posix.dirname(partPath), "_rels", `${posix.basename(partPath)}.rels`);
  if (!archive.has(relationPart)) return new Map();
  return parseRelationships(archive.readText(relationPart, signal), partPath);
}

function parseRelationships(xml: string, partPath: string): ReadonlyMap<string, Relationship> {
  const parsed = parseXml(xml);
  const root = child(parsed, "Relationships");
  const items = asRecordArray(child(root, "Relationship"));
  const result = new Map<string, Relationship>();
  for (const item of items) {
    const id = attribute(item, "@_Id");
    const target = attribute(item, "@_Target");
    if (id === null || target === null) continue;
    if (result.has(id)) {
      throw new LocalAdapterError("SOURCE_UNREADABLE", `关系 ID 重复 ${id}`);
    }
    const targetMode = attribute(item, "@_TargetMode");
    const type = attribute(item, "@_Type") ?? "";
    if (targetMode === "External" || isExternalTarget(target)) {
      result.set(id, {
        id,
        type,
        target,
        external: true,
        packagePath: null,
      });
      continue;
    }
    const packagePath = resolvePackageTarget(partPath, target);
    result.set(id, {
      id,
      type,
      target,
      external: false,
      packagePath,
    });
  }
  return result;
}

function resolvePackageTarget(partPath: string, target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch (error: unknown) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", "关系目标编码无法解析", { cause: error });
  }
  const withoutFragment = decoded.split("#", 1)[0] ?? decoded;
  if (withoutFragment.includes("\\")) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", "关系目标包含反斜杠");
  }
  const joined = withoutFragment.startsWith("/")
    ? withoutFragment.slice(1)
    : posix.join(posix.dirname(partPath), withoutFragment);
  const normalized = posix.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", `关系目标越界 ${target}`);
  }
  return normalized;
}

function isExternalTarget(target: string): boolean {
  return /^(?:https?|ftp):/iu.test(target) || target.startsWith("//");
}

function extractParagraphs(root: unknown): string[] {
  const paragraphs: string[] = [];
  walkForParagraphs(root, paragraphs);
  return paragraphs.map(normalizeText).filter((text) => text.length > 0);
}

function walkForParagraphs(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walkForParagraphs(item, result);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key === "a:p") {
      for (const paragraph of asRecordArray(childValue)) {
        const text = collectText(paragraph, "a:t").join("").trim();
        if (text !== "") result.push(text);
      }
    } else {
      walkForParagraphs(childValue, result);
    }
  }
}

function readNotes(
  archive: ZipArchive,
  relationships: ReadonlyMap<string, Relationship>,
  page: number,
  warnings: ExtractionWarning[],
  signal: AbortSignal | undefined,
): string {
  const notesRelationship = [...relationships.values()].find((item) => item.type.endsWith("/notesSlide"));
  if (notesRelationship === undefined || notesRelationship.packagePath === null) return "";
  if (!archive.has(notesRelationship.packagePath)) {
    warnings.push({
      code: "RELATIONSHIP_MISSING",
      message: `第 ${page} 页 notesSlide 关系目标不存在`,
      sectionId: makeId("sec", page),
      locator: { kind: "page", page },
    });
    return "";
  }
  const notesXml = parseXml(archive.readText(notesRelationship.packagePath, signal));
  return extractParagraphs(notesXml).join("\n");
}

function extractMediaRefs(
  slideXml: unknown,
  relationships: ReadonlyMap<string, Relationship>,
  archive: ZipArchive,
): PptxMediaRef[] {
  const refs = new Map<string, PptxMediaRef>();
  const relationIds = new Set<string>();
  collectRelationshipIds(slideXml, relationIds);
  for (const id of relationIds) {
    const relationship = relationships.get(id);
    if (relationship === undefined) continue;
    if (relationship.external) {
      if (isMediaRelationship(relationship)) {
        refs.set(`external:${relationship.target}`, {
          key: `external:${relationship.target}`,
          sourceInternalPath: relationship.target,
          external: true,
          packagePath: null,
        });
      }
      continue;
    }
    if (!isMediaRelationship(relationship) && !relationship.target.startsWith("../media/")) {
      continue;
    }
    const packagePath = relationship.packagePath;
    if (packagePath === null) continue;
    if (!archive.has(packagePath) && !packagePath.startsWith("ppt/media/")) continue;
    refs.set(`path:${packagePath}`, {
      key: `path:${packagePath}`,
      sourceInternalPath: packagePath,
      external: false,
      packagePath,
    });
  }
  return [...refs.values()];
}

function isMediaRelationship(relationship: Relationship): boolean {
  return (
    relationship.type.endsWith("/image") ||
    relationship.type.endsWith("/video") ||
    relationship.type.endsWith("/media")
  );
}

function collectRelationshipIds(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRelationshipIds(item, result);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, childValue] of Object.entries(value)) {
    if (key.startsWith("@_r:") && typeof childValue === "string" && childValue !== "") {
      result.add(childValue);
    } else {
      collectRelationshipIds(childValue, result);
    }
  }
}

function allMediaArchivePaths(archive: ZipArchive): string[] {
  return [...archive.entries.keys()]
    .filter((name) => name.startsWith("ppt/media/") && !name.endsWith("/"))
    .sort((left, right) => left.localeCompare(right));
}

function isSelectedPptxPart(name: string): boolean {
  return (
    name === "[Content_Types].xml" ||
    name === "_rels/.rels" ||
    name === "docProps/core.xml" ||
    name === "ppt/presentation.xml" ||
    name === "ppt/_rels/presentation.xml.rels" ||
    name.startsWith("ppt/slides/") ||
    name.startsWith("ppt/notesSlides/") ||
    name.startsWith("ppt/media/")
  );
}

function documentTitle(archive: ZipArchive): string | null {
  if (!archive.has("docProps/core.xml")) return null;
  const xml = archive.readText("docProps/core.xml");
  const parsed = parseXml(xml);
  const title = normalizeText(collectText(parsed, "dc:title").join(""));
  return title === "" ? null : title;
}

function fallbackDocumentTitle(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension === "" ? "未命名演示文稿" : oneLine(withoutExtension, 500);
}

function extensionForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
  };
  return normalizeExtension(map[mime] ?? ".bin");
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

