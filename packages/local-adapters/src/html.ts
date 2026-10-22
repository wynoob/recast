import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { load, type CheerioAPI } from "cheerio";
import { isTag, isText, type AnyNode, type Element } from "domhandler";
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
  type ParagraphBlock,
} from "./contracts.js";
import {
  abortIfNeeded,
  contextAfter,
  contextBefore,
  detectMime,
  ensureStagingDir,
  extensionForPath,
  isInsideRoot,
  isMissingPathError,
  makeId,
  normalizeExtension,
  normalizeText,
  oneLine,
  readHead,
  readFileLimited,
  requireRegularFile,
  sha256File,
  stageFileByHash,
  toPosix,
} from "./util.js";

interface SectionDraft {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly headingPath: string;
  readonly locator: { kind: "dom"; domPath: string };
  readonly blocks: ParagraphBlock[];
  readonly paragraphTexts: string[];
}

interface OccurrenceDraft {
  readonly mediaId: string;
  readonly sectionId: string;
  readonly locator: { kind: "dom"; domPath: string };
  readonly anchorIndex: number;
  readonly mediaStatus: "extracted" | "missing";
  readonly headingPath: string;
}

interface ResourceResolution {
  readonly key: string;
  readonly sourceInternalPath: string;
  readonly status: "extracted" | "missing";
  readonly errorCode: "MISSING_DEPENDENCY" | "PATH_NOT_ALLOWED" | "EXTERNAL_LINK_BLOCKED" | "UNSUPPORTED_FORMAT" | "CAPACITY_EXCEEDED";
  readonly message: string;
  readonly localPath: string | null;
}

const BLOCK_TAGS = new Set(["p", "li", "blockquote", "figcaption", "pre", "td", "th",
  "body", "div", "section", "article", "main", "header", "footer", "nav", "aside",
  "ul", "ol", "table", "tr", "dl", "dt", "dd", "figure", "hr", "address"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MEDIA_TAGS = new Set(["img", "source", "video", "audio", "object", "embed"]);

export async function extractStaticHtml(input: ExtractionInput): Promise<ExtractedDocument> {
  const limits = resolveLimits(input.options);
  const stagingDir = await ensureStagingDir(input.stagingDir);
  const source = await requireRegularFile(input.sourcePath, limits.maxInputBytes);
  abortIfNeeded(input.signal);
  const htmlBytes = await readFileLimited(source.absolute, limits.maxInputBytes, input.signal);
  const originalSha256 = await sha256File(source.absolute, input.signal);
  const htmlDir = dirname(source.absolute);
  const rootReal = await realpath(htmlDir);
  const $ = load(htmlBytes, null, true);
  const dynamic = hasDynamicContent($);
  const warnings: ExtractionWarning[] = [];
  const mediaResources: ExtractedMediaResource[] = [];
  const mediaByKey = new Map<string, ExtractedMediaResource>();
  const occurrenceDrafts: OccurrenceDraft[] = [];
  const sections: SectionDraft[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let currentSection: SectionDraft | null = null;
  const budget = new ExtractionBudget(limits);
  const metadataTitle = normalizeText($("title").first().text());
  budget.reserveText(metadataTitle);
  let sectionOrder = 0;
  let occurrenceAnchor = 0;

  if (dynamic) {
    warnings.push({
      code: "DYNAMIC_HTML_NEEDS_ADAPTER",
      message: "检测到脚本或内嵌文档；未执行脚本、未联网，静态 DOM 结果标记 needs_adapter",
      sectionId: null,
      locator: null,
    });
  }

  const ensureSection = (locator: Element | null): SectionDraft => {
    if (currentSection !== null) return currentSection;
    sectionOrder += 1;
    const domPath = locator === null ? "body" : domPathOf(locator);
    const title = normalizeText($("title").first().text()) || "正文";
    currentSection = {
      id: makeId("sec", sectionOrder),
      order: sectionOrder,
      title: title === "" ? "正文" : oneLine(title, 500),
      headingPath: title === "" ? "正文" : oneLine(title, 4096),
      locator: { kind: "dom", domPath },
      blocks: [],
      paragraphTexts: [],
    };
    sections.push(currentSection);
    return currentSection;
  };

  const body = $("body").get(0);
  for (const event of body === undefined ? [] : htmlEvents(body)) {
    abortIfNeeded(input.signal);
    const element = event.element;

    if (event.kind === "heading") {
      const title = event.text;
      budget.reserveText(title);
      if (title === "") continue;
      const level = Number(element.name.slice(1));
      while (headingStack.length > 0 && (headingStack.at(-1)?.level ?? 0) >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      sectionOrder += 1;
      currentSection = {
        id: makeId("sec", sectionOrder),
        order: sectionOrder,
        title: oneLine(title, 500),
        headingPath: oneLine(headingStack.map((item) => item.title).join(" > "), 4096),
        locator: { kind: "dom", domPath: domPathOf(element) },
        blocks: [],
        paragraphTexts: [],
      };
      sections.push(currentSection);
      occurrenceAnchor = 0;
      continue;
    }

    if (event.kind === "paragraph") {
      const section = ensureSection(element);
      const text = event.text;
      budget.reserveText(text);
      const paragraphIndex = section.blocks.length;
      section.blocks.push({
        id: `${section.id}-p${paragraphIndex + 1}`,
        kind: "paragraph",
        text,
        locator: { kind: "dom", domPath: domPathOf(element) },
      });
      section.paragraphTexts.push(text);
      occurrenceAnchor = section.paragraphTexts.length;
      continue;
    }

    if (event.kind === "media") {
      const targets = mediaTargets($, element);
      if (targets.length === 0) continue;
      const section = ensureSection(element);
      for (const rawTarget of targets) {
        abortIfNeeded(input.signal);
        const resolution = await resolveHtmlResource({
          rawTarget,
          rootReal,
          limits,
          signal: input.signal,
        });
        let resource = mediaByKey.get(resolution.key);
        if (resource === undefined) {
          budget.reserveMedia();
          resource = await materializeHtmlResource({
            id: `media-${mediaResources.length + 1}`,
            resolution,
            stagingDir,
            signal: input.signal,
            limits,
            warnings,
          });
          mediaByKey.set(resolution.key, resource);
          mediaResources.push(resource);
        }
        occurrenceDrafts.push({
          mediaId: resource.id,
          sectionId: section.id,
          locator: { kind: "dom", domPath: domPathOf(element) },
          anchorIndex: occurrenceAnchor,
          mediaStatus: resource.status,
          headingPath: section.headingPath,
        });
      }
    }
  }

  if (sections.length === 0) {
    const fallback = ensureSection(null);
    if (fallback.blocks.length === 0 && mediaResources.length === 0) {
      warnings.push({
        code: "PAGE_TEXT_EMPTY",
        message: "HTML 静态 DOM 没有可提取的正文或媒体",
        sectionId: fallback.id,
        locator: null,
      });
    }
  }
  if (sections.length > limits.maxSections) {
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "HTML 章节数量超过上限", {
      details: { sections: sections.length, maxSections: limits.maxSections },
    });
  }

  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const occurrences: MediaOccurrence[] = occurrenceDrafts.map((draft, index) => {
    const section = sectionById.get(draft.sectionId);
    const paragraphs = section?.paragraphTexts ?? [];
    return {
      id: makeId("occ", index + 1),
      mediaId: draft.mediaId,
      sectionId: draft.sectionId,
      locator: draft.locator,
      headingPath: draft.headingPath,
      beforeText: contextBefore(paragraphs, draft.anchorIndex),
      afterText: contextAfter(paragraphs, draft.anchorIndex),
      mediaStatus: draft.mediaStatus,
    };
  });

  const extractedSections: ExtractedSection[] = sections.map((section) => ({
    id: section.id,
    order: section.order,
    title: section.title,
    headingPath: section.headingPath,
    locator: section.locator,
    blocks: section.blocks,
    notes: "",
  }));
  const pageTitle =
    normalizeText($("title").first().text()) ||
    extractedSections[0]?.title ||
    source.fileName.replace(/\.[^.]+$/u, "") ||
    "未命名 HTML";
  const hasText = headingStack.length > 0 || extractedSections.some((section) => section.blocks.length > 0);
  const missingMedia = mediaResources.some((item) => item.status === "missing");
  const status = !hasText && mediaResources.length === 0 ? "blocked" : dynamic || missingMedia ? "partial" : "complete";

  const result = {
    schemaVersion: 1 as const,
    format: "html" as const,
    processorVersion: PROCESSOR_VERSION.html,
    originalSha256,
    sourceFileName: source.fileName,
    sourceBytes: source.bytes,
    title: oneLine(pageTitle, 500),
    pageCount: null,
    sections: extractedSections,
    media: mediaResources,
    occurrences,
    warnings,
    status,
    capabilities: {
      pageImages: "not_applicable" as const,
      libreOffice: "not_applicable" as const,
      ocr: "blocked" as const,
      renderer: null,
    },
  };
  return ExtractedDocumentSchema.parse(result);
}

function hasDynamicContent($: CheerioAPI): boolean {
  if ($("iframe").length > 0) return true;
  const executableScript = $("script").toArray().some((script) => {
    if (!isTag(script)) return false;
    const type = (script.attribs["type"] ?? "").toLowerCase();
    const inertType =
      type !== "" &&
      type !== "text/javascript" &&
      type !== "application/javascript" &&
      type !== "module";
    if (inertType) return false;
    return (script.attribs["src"] ?? "") !== "" || $(script).text().trim() !== "";
  });
  if (executableScript) return true;
  const elements = $("*").toArray();
  return elements.some(
    (element) =>
      isTag(element) &&
      Object.keys(element.attribs).some((name) => name.toLowerCase().startsWith("on")),
  );
}

type HtmlEvent =
  | { readonly kind: "heading" | "paragraph"; readonly element: Element; readonly text: string }
  | { readonly kind: "media"; readonly element: Element };

function isHidden(element: Element): boolean {
  const style = element.attribs["style"] ?? "";
  return "hidden" in element.attribs ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(style);
}

function headingContent(element: Element): { text: string; media: readonly Element[] } {
  const texts: string[] = [];
  const media: Element[] = [];
  function visit(node: AnyNode): void {
    if (isText(node)) {
      texts.push(node.data);
      return;
    }
    if (!isTag(node) || SKIP_TAGS.has(node.name) || isHidden(node)) return;
    if (node.name === "br") texts.push("\n");
    if (MEDIA_TAGS.has(node.name)) media.push(node);
    for (const child of node.children) visit(child);
  }
  visit(element);
  return { text: normalizeText(texts.join("")), media };
}

function* htmlEvents(body: Element): Generator<HtmlEvent> {
  let pending: string[] = [];
  let owner: Element = body;
  function* flush(): Generator<HtmlEvent> {
    const text = normalizeText(pending.join(""));
    pending = [];
    if (text !== "") yield { kind: "paragraph", element: owner, text };
  }
  function* visit(node: AnyNode): Generator<HtmlEvent> {
    if (isText(node)) {
      if (pending.length === 0 && node.parent !== null && isTag(node.parent)) owner = node.parent;
      pending.push(node.data);
      return;
    }
    if (!isTag(node) || SKIP_TAGS.has(node.name) || isHidden(node)) return;
    if (HEADING_TAGS.has(node.name)) {
      yield* flush();
      const { text, media } = headingContent(node);
      if (text !== "") yield { kind: "heading", element: node, text };
      for (const element of media) yield { kind: "media", element };
      return;
    }
    if (node.name === "br") {
      pending.push("\n");
      return;
    }
    const boundary = BLOCK_TAGS.has(node.name) || MEDIA_TAGS.has(node.name);
    if (boundary) yield* flush();
    if (MEDIA_TAGS.has(node.name)) yield { kind: "media", element: node };
    for (const child of node.children) yield* visit(child);
    if (boundary) yield* flush();
  }
  yield* visit(body);
  yield* flush();
}

function domPathOf(element: Element): string {
  const parts: string[] = [];
  let current: AnyNode | null = element;
  while (current !== null && isTag(current)) {
    const parent: AnyNode | null = current.parent;
    if (parent !== null && isTag(parent)) {
      const siblings = parent.children.filter(isTag);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${current.name}:nth-child(${Math.max(index, 1)})`);
      current = parent;
    } else {
      parts.unshift(current.name);
      break;
    }
  }
  return parts.length === 0 ? "body" : parts.join(" > ");
}

function mediaTargets($: CheerioAPI, element: Element): string[] {
  const raw: (string | undefined)[] = [];
  if (element.name === "img" || element.name === "source" || element.name === "video" || element.name === "audio" || element.name === "embed") {
    raw.push($(element).attr("src"));
  }
  if (element.name === "video") raw.push($(element).attr("poster"));
  if (element.name === "object") raw.push($(element).attr("data"));
  return [...new Set(raw.filter((value): value is string => value !== undefined && value.trim() !== ""))];
}

async function resolveHtmlResource(args: {
  readonly rawTarget: string;
  readonly rootReal: string;
  readonly limits: ExtractionLimits;
  readonly signal: AbortSignal | undefined;
}): Promise<ResourceResolution> {
  abortIfNeeded(args.signal);
  const raw = args.rawTarget.trim();
  if (/^(?:https?:|mailto:|ftp:)/iu.test(raw) || raw.startsWith("//")) {
    return {
      key: `external:${raw}`,
      sourceInternalPath: raw,
      status: "missing",
      errorCode: "EXTERNAL_LINK_BLOCKED",
      message: "外部链接未联网读取",
      localPath: null,
    };
  }
  if (raw.startsWith("data:") || raw.startsWith("javascript:")) {
    return {
      key: `unsupported:${raw.slice(0, 200)}`,
      sourceInternalPath: raw.slice(0, 4096),
      status: "missing",
      errorCode: "UNSUPPORTED_FORMAT",
      message: "内联或脚本 URL 不执行、不读取",
      localPath: null,
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    return {
      key: `blocked:${raw}`,
      sourceInternalPath: raw,
      status: "missing",
      errorCode: "PATH_NOT_ALLOWED",
      message: "非 http(s) 协议或本机文件 URI 不允许读取",
      localPath: null,
    };
  }
  const withoutFragment = raw.split("#", 1)[0] ?? raw;
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? withoutFragment;
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return {
      key: `unsupported:${raw}`,
      sourceInternalPath: raw,
      status: "missing",
      errorCode: "UNSUPPORTED_FORMAT",
      message: "相对资源路径编码无法解析",
      localPath: null,
    };
  }
  if (decoded.includes("\\") || isAbsolute(decoded) || /^[a-z]:/iu.test(decoded)) {
    return {
      key: `blocked:${decoded}`,
      sourceInternalPath: decoded,
      status: "missing",
      errorCode: "PATH_NOT_ALLOWED",
      message: "绝对路径或反斜杠路径不允许读取",
      localPath: null,
    };
  }
  const candidate = resolve(args.rootReal, decoded);
  const lexicalRelative = toPosix(relative(args.rootReal, candidate));
  if (!isInsideRoot(args.rootReal, candidate)) {
    return {
      key: `blocked:${lexicalRelative}`,
      sourceInternalPath: lexicalRelative,
      status: "missing",
      errorCode: "PATH_NOT_ALLOWED",
      message: "资源路径越过 HTML 根目录",
      localPath: null,
    };
  }

  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(candidate);
      if (!isInsideRoot(args.rootReal, resolved)) {
        return {
          key: `blocked:${lexicalRelative}`,
          sourceInternalPath: lexicalRelative,
          status: "missing",
          errorCode: "PATH_NOT_ALLOWED",
          message: "符号链接指向 HTML 根目录之外",
          localPath: null,
        };
      }
    }
    if (!info.isFile() && !info.isSymbolicLink()) {
      return {
        key: `unsupported:${lexicalRelative}`,
        sourceInternalPath: lexicalRelative,
        status: "missing",
        errorCode: "UNSUPPORTED_FORMAT",
        message: "资源不是普通文件",
        localPath: null,
      };
    }
    const realCandidate = await realpath(candidate);
    const realInfo = await stat(realCandidate);
    if (realInfo.size > args.limits.maxHtmlDependencyBytes) {
      return {
        key: `blocked:${lexicalRelative}`,
        sourceInternalPath: lexicalRelative,
        status: "missing",
        errorCode: "CAPACITY_EXCEEDED",
        message: "单个 HTML 依赖超过容量上限",
        localPath: null,
      };
    }
    if (!isInsideRoot(args.rootReal, realCandidate)) {
      return {
        key: `blocked:${lexicalRelative}`,
        sourceInternalPath: lexicalRelative,
        status: "missing",
        errorCode: "PATH_NOT_ALLOWED",
        message: "资源真实路径越过 HTML 根目录",
        localPath: null,
      };
    }
    return {
      key: `local:${realCandidate}`,
      sourceInternalPath: toPosix(relative(args.rootReal, realCandidate)),
      status: "extracted",
      errorCode: "MISSING_DEPENDENCY",
      message: "",
      localPath: realCandidate,
    };
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return {
        key: `missing:${lexicalRelative}`,
        sourceInternalPath: lexicalRelative,
        status: "missing",
        errorCode: "MISSING_DEPENDENCY",
        message: "相对资源不存在",
        localPath: null,
      };
    }
    throw error;
  }
}

async function materializeHtmlResource(args: {
  readonly id: string;
  readonly resolution: ResourceResolution;
  readonly stagingDir: string;
  readonly signal: AbortSignal | undefined;
  readonly limits: ExtractionLimits;
  readonly warnings: ExtractionWarning[];
}): Promise<ExtractedMediaResource> {
  const id = args.id;
  if (args.resolution.status === "missing" || args.resolution.localPath === null) {
    args.warnings.push({
      code:
        args.resolution.errorCode === "EXTERNAL_LINK_BLOCKED"
          ? "EXTERNAL_LINK_BLOCKED"
          : args.resolution.errorCode === "MISSING_DEPENDENCY"
            ? "MISSING_DEPENDENCY"
            : args.resolution.errorCode === "CAPACITY_EXCEEDED"
              ? "CAPACITY_EXCEEDED"
              : "UNSUPPORTED_MEDIA",
      message: `${args.resolution.message}：${args.resolution.sourceInternalPath}`,
      sectionId: null,
      locator: null,
    });
    return {
      id,
      sourceInternalPath: args.resolution.sourceInternalPath,
      status: "missing",
      mediaKind: "unknown",
      mime: null,
      errorCode: args.resolution.errorCode,
      message: args.resolution.message,
    };
  }

  const localPath = args.resolution.localPath;
  const info = await lstat(localPath);
  if (info.size > args.limits.maxHtmlDependencyBytes) {
    return {
      id,
      sourceInternalPath: args.resolution.sourceInternalPath,
      status: "missing",
      mediaKind: "unknown",
      mime: null,
      errorCode: "CAPACITY_EXCEEDED",
      message: "单个 HTML 依赖超过容量上限",
    };
  }
  const head = await readHead(localPath, 512);
  const detected = detectMime(head, localPath);
  if (detected.mime === "application/octet-stream") {
    args.warnings.push({
      code: "UNSUPPORTED_MEDIA",
      message: `HTML 依赖类型未识别，按原始字节保存：${args.resolution.sourceInternalPath}`,
      sectionId: null,
      locator: null,
    });
  }
  const hash = await sha256File(localPath, args.signal);
  const staged = await stageFileByHash({
    sourcePath: localPath,
    stagingDir: args.stagingDir,
    extension: extensionForPath(localPath) || extensionForMime(detected.mime),
    signal: args.signal,
    hash,
    bytes: info.size,
  });
  return {
    id,
    sourceInternalPath: args.resolution.sourceInternalPath,
    status: "extracted",
    mediaKind: detected.mediaKind,
    mime: detected.mime,
    stagedPath: staged.stagedPath,
    sha256: staged.sha256,
    bytes: staged.bytes,
  };
}

function extensionForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
  };
  return normalizeExtension(map[mime] ?? ".bin");
}

