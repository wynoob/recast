import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import {
  DocumentSectionDraftSchema,
  MarkdownOccurrenceDraftSchema,
  type DocumentSectionDraft,
  type MarkdownOccurrenceDraft,
} from "@dmall/contracts";
import { isSupportedExtension, scanMarkdownLines, type MarkdownLine } from "@dmall/domain";

interface Heading {
  level: number;
  title: string;
  line: number;
}

interface TextBlock {
  startLine: number;
  endLine: number;
  text: string;
  sectionIndex: number;
}

interface RawImage {
  line: number;
  column: number;
  target: string;
}

export async function parseMarkdown(input: {
  text: string;
  rootPath: string;
  relativePath: string;
  knownFiles?: readonly string[];
}): Promise<MarkdownOccurrenceDraft[]> {
  return (await parseMarkdownDocument(input)).occurrences;
}

export async function parseMarkdownDocument(input: {
  text: string;
  rootPath: string;
  relativePath: string;
  knownFiles?: readonly string[];
}): Promise<{
  title: string;
  sections: DocumentSectionDraft[];
  occurrences: MarkdownOccurrenceDraft[];
}> {
  const lines = scanMarkdownLines(input.text);
  const definitions = collectReferenceDefinitions(lines);
  const headings: Heading[] = [];
  const blocks: TextBlock[] = [];
  const images: RawImage[] = [];
  let sectionIndex = 0;
  let paragraph: { start: number; lines: string[] } | null = null;

  const flushParagraph = (endLine: number): void => {
    if (paragraph === null) return;
    const text = paragraph.lines.join("\n").trim();
    if (text !== "") {
      blocks.push({
        startLine: paragraph.start,
        endLine: endLine + 1,
        text,
        sectionIndex,
      });
    }
    paragraph = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const scanned = lines[index];
    if (scanned === undefined) continue;
    if (scanned.kind === "fence" || (scanned.kind === "code" && scanned.source === "fenced")) {
      flushParagraph(index - 1);
      continue;
    }
    if (scanned.kind === "heading") {
      flushParagraph(index - 1);
      if (scanned.title === "") continue;
      headings.push({
        level: scanned.level,
        title: scanned.title,
        line: scanned.lineNumber,
      });
      sectionIndex += 1;
      continue;
    }
    const line = scanned.raw;
    const nextLine = lines[index + 1];
    if (
      scanned.kind === "content" &&
      line.trim() !== "" &&
      nextLine?.kind === "content" &&
      /^ {0,3}(?:=+|-+)[ \t]*$/u.test(nextLine.raw)
    ) {
      flushParagraph(index - 1);
      headings.push({ level: nextLine.raw.includes("=") ? 1 : 2, title: line.trim(), line: scanned.lineNumber });
      sectionIndex += 1;
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph(index - 1);
      continue;
    }
    if (scanned.kind === "content") collectLineImages(line, index, definitions, images);
    const textOnly = scanned.kind === "code" ? line.trim() : stripImageSyntax(line).trim();
    if (textOnly === "") {
      flushParagraph(index - 1);
      continue;
    }
    paragraph ??= { start: scanned.lineNumber, lines: [] };
    paragraph.lines.push(textOnly);
  }
  flushParagraph(lines.length);

  const sorted = images
    .sort((left, right) => left.line - right.line || left.column - right.column)
    .slice(0, 10_000);
  const results: MarkdownOccurrenceDraft[] = [];
  for (const [ordinal, image] of sorted.entries()) {
    const resolved = await resolveTarget(
      input.rootPath,
      input.relativePath,
      image.target,
      input.knownFiles === undefined ? null : new Set(input.knownFiles),
    );
    const section = sectionForLine(headings, image.line);
    const headingPath = headingPathFor(headings, image.line);
    const beforeText = boundedContext(
      blocks
        .filter((block) => block.sectionIndex === section && block.endLine < image.line)
        .slice(-2),
      true,
    );
    const afterText = boundedContext(
      blocks
        .filter((block) => block.sectionIndex === section && block.startLine > image.line)
        .slice(0, 2),
    );
    results.push(
      MarkdownOccurrenceDraftSchema.parse({
        locator: {
          schemaVersion: 1,
          kind: "markdown",
          line: image.line,
          column: image.column,
          ordinal,
          rawTarget: image.target,
          normalizedRelativePath: resolved.normalizedRelativePath,
          resolution: resolved.resolution,
        },
        headingPath,
        beforeText,
        afterText,
        mediaStatus: resolved.mediaStatus,
        resolvedRelativePath: resolved.resolvedRelativePath,
        errorCode: resolved.errorCode,
      }),
    );
  }
  const sections = markdownSections(input.relativePath, headings, blocks);
  return {
    title: headings[0]?.title ?? input.relativePath.split("/").at(-1)?.replace(/\.[^.]+$/u, "") ?? "未命名文档",
    sections,
    occurrences: results,
  };
}

function markdownSections(
  relativePath: string,
  headings: Heading[],
  blocks: TextBlock[],
): DocumentSectionDraft[] {
  const fileName = relativePath.split("/").at(-1)?.replace(/\.[^.]+$/u, "") ?? "未命名文档";
  const sections: DocumentSectionDraft[] = [];
  const sectionHeads = new Map<number, Heading>();
  for (const [index, heading] of headings.entries()) {
    sectionHeads.set(index + 1, heading);
  }
  const indexes = new Set<number>(blocks.map((block) => block.sectionIndex));
  for (const index of sectionHeads.keys()) indexes.add(index);
  if (indexes.size === 0) indexes.add(0);

  for (const index of [...indexes].sort((left, right) => left - right)) {
    const heading = sectionHeads.get(index);
    const sectionBlocks = blocks.filter((block) => block.sectionIndex === index);
    const line = heading?.line ?? sectionBlocks[0]?.startLine ?? 1;
    const title = heading?.title ?? fileName;
    const headingPath = headingPathFor(headings, line) || title;
    sections.push(
      DocumentSectionDraftSchema.parse({
        adapterId: `md-section-${index}`,
        ordinal: sections.length + 1,
        title: title === "" ? fileName : title,
        headingPath: headingPath === "" ? fileName : headingPath,
        text: sectionBlocks.map((block) => block.text).join("\n\n"),
        locator: {
          schemaVersion: 1,
          kind: "markdown_text",
          line,
          column: 1,
        },
        blocks: sectionBlocks.map((block, blockIndex) => ({
          adapterId: `md-block-${index}-${blockIndex + 1}`,
          ordinal: blockIndex + 1,
          text: block.text,
          locator: {
            schemaVersion: 1,
            kind: "markdown_text",
            line: block.startLine,
            column: 1,
          },
        })),
        notes: "",
      }),
    );
  }
  return sections;
}

function collectReferenceDefinitions(lines: MarkdownLine[]): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const line of lines) {
    if (line.kind !== "content") continue;
    const match = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)/u.exec(line.raw);
    if (match === null) continue;
    const label = normalizeReference(match[1] ?? "");
    const target = stripAngle(match[2] ?? "");
    if (label !== "" && target !== "") definitions.set(label, target);
  }
  return definitions;
}

function collectLineImages(
  line: string,
  lineIndex: number,
  definitions: Map<string, string>,
  images: RawImage[],
): void {
  const inline = /!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu;
  for (const match of line.matchAll(inline)) {
    const target = stripAngle(match[1] ?? "");
    if (target === "") continue;
    images.push({
      line: lineIndex + 1,
      column: (match.index ?? 0) + 1,
      target,
    });
  }
  const reference = /!\[([^\]]*)\]\[([^\]]*)\]/gu;
  for (const match of line.matchAll(reference)) {
    const label = normalizeReference(match[2] === "" ? (match[1] ?? "") : (match[2] ?? ""));
    const target = definitions.get(label);
    if (target === undefined) continue;
    images.push({
      line: lineIndex + 1,
      column: (match.index ?? 0) + 1,
      target,
    });
  }
  const html = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const match of line.matchAll(html)) {
    const target = match[1] ?? match[2] ?? match[3] ?? "";
    if (target === "") continue;
    images.push({
      line: lineIndex + 1,
      column: (match.index ?? 0) + 1,
      target,
    });
  }
}

async function resolveTarget(
  rootPath: string,
  relativePath: string,
  rawTarget: string,
  knownFiles: Set<string> | null,
): Promise<{
  normalizedRelativePath: string;
  resolution: "inside_root" | "missing" | "outside_root" | "external_url";
  resolvedRelativePath: string | null;
  mediaStatus: "available" | "missing" | "unsupported";
  errorCode: "MISSING_DEPENDENCY" | "SYMLINK_OUTSIDE_ROOT" | "UNSUPPORTED_FORMAT" | null;
}> {
  if (/^https?:\/\//iu.test(rawTarget)) {
    return {
      normalizedRelativePath: rawTarget,
      resolution: "external_url",
      resolvedRelativePath: null,
      mediaStatus: "unsupported",
      errorCode: "UNSUPPORTED_FORMAT",
    };
  }
  if (/^file:\/\//iu.test(rawTarget) || isAbsolute(rawTarget) || /^[A-Za-z]:[\\/]/u.test(rawTarget)) {
    return {
      normalizedRelativePath: rawTarget,
      resolution: "outside_root",
      resolvedRelativePath: null,
      mediaStatus: "missing",
      errorCode: "MISSING_DEPENDENCY",
    };
  }
  const withoutQuery = rawTarget.split(/[?#]/u, 1)[0] ?? rawTarget;
  const decoded = safeDecode(withoutQuery);
  const mdDirectory = dirname(relativePath);
  const normalized = posix.normalize(posix.join(mdDirectory === "." ? "" : mdDirectory, decoded));
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    return {
      normalizedRelativePath: normalized,
      resolution: "outside_root",
      resolvedRelativePath: null,
      mediaStatus: "missing",
      errorCode: "MISSING_DEPENDENCY",
    };
  }
  if (knownFiles !== null) {
    if (!knownFiles.has(normalized)) {
      return {
        normalizedRelativePath: normalized,
        resolution: "missing",
        resolvedRelativePath: normalized,
        mediaStatus: "missing",
        errorCode: "MISSING_DEPENDENCY",
      };
    }
    if (!isSupportedExtension(normalized)) {
      return {
        normalizedRelativePath: normalized,
        resolution: "inside_root",
        resolvedRelativePath: normalized,
        mediaStatus: "unsupported",
        errorCode: "UNSUPPORTED_FORMAT",
      };
    }
    return {
      normalizedRelativePath: normalized,
      resolution: "inside_root",
      resolvedRelativePath: normalized,
      mediaStatus: "available",
      errorCode: null,
    };
  }
  const absolute = resolve(rootPath, ...normalized.split("/"));
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      const realTarget = await realpath(absolute);
      const realRoot = await realpath(rootPath);
      if (!realTarget.startsWith(`${realRoot}/`)) {
        return {
          normalizedRelativePath: normalized,
          resolution: "outside_root",
          resolvedRelativePath: null,
          mediaStatus: "missing",
          errorCode: "SYMLINK_OUTSIDE_ROOT",
        };
      }
      return {
        normalizedRelativePath: normalized,
        resolution: "inside_root",
        resolvedRelativePath: normalized,
        mediaStatus: "unsupported",
        errorCode: "UNSUPPORTED_FORMAT",
      };
    }
    if (!stats.isFile() || !isSupportedExtension(normalized)) {
      return {
        normalizedRelativePath: normalized,
        resolution: "inside_root",
        resolvedRelativePath: normalized,
        mediaStatus: "unsupported",
        errorCode: "UNSUPPORTED_FORMAT",
      };
    }
    return {
      normalizedRelativePath: normalized,
      resolution: "inside_root",
      resolvedRelativePath: normalized,
      mediaStatus: "available",
      errorCode: null,
    };
  } catch {
    return {
      normalizedRelativePath: normalized,
      resolution: "missing",
      resolvedRelativePath: normalized,
      mediaStatus: "missing",
      errorCode: "MISSING_DEPENDENCY",
    };
  }
}

function sectionForLine(headings: Heading[], line: number): number {
  let section = 0;
  for (const heading of headings) {
    if (heading.line > line) break;
    section += 1;
  }
  return section;
}

function headingPathFor(headings: Heading[], line: number): string {
  const stack: Heading[] = [];
  for (const heading of headings) {
    if (heading.line > line) break;
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.map((heading) => heading.title).join(" > ");
}

function boundedContext(blocks: TextBlock[], before = false): string {
  const text = blocks.map(block => block.text).join("\n\n");
  return before ? text.slice(-1_000) : text.slice(0, 1_000);
}

function normalizeReference(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

function stripAngle(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value).replace(/\\([()[\]])/gu, "$1");
  } catch {
    return value;
  }
}

function stripImageSyntax(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/gu, "")
    .replace(/<img\b[^>]*>/giu, "")
    .replace(/<image\b[^>]*\/?>/giu, "")
    .replace(
      /<\/?(?:text|quote-container|callout|mention-doc|lark-td|lark-tr|lark-table|grid|column|whiteboard|sheet|bitable)\b[^>]*>/giu,
      "",
    )
    .replace(
      /\{(?:align|color|background-color|border-color)\s*=\s*"[^"]*"(?:\s+(?:align|color|background-color|border-color)\s*=\s*"[^"]*")*\}/giu,
      "",
    )
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/(\*\*|__|~~|`)/gu, "")
    .trim();
}
