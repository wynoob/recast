import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import type { MediaKind } from "./contracts.js";
import { LocalAdapterError } from "./contracts.js";

export function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("提取已取消", "AbortError");
  }
}

export async function ensureStagingDir(stagingDir: string): Promise<string> {
  const absolute = resolve(stagingDir);
  await mkdir(absolute, { recursive: true });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", "staging 目录不能是符号链接或普通文件");
  }
  return absolute;
}

export async function requireRegularFile(
  sourcePath: string,
  maxBytes: number,
): Promise<{ absolute: string; bytes: number; fileName: string }> {
  const absolute = resolve(sourcePath);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new LocalAdapterError("SOURCE_UNREADABLE", "原件必须是普通文件，不能是目录或符号链接");
  }
  if (info.size > maxBytes) {
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "原件超过输入容量上限", {
      details: { bytes: info.size, maxBytes },
    });
  }
  return { absolute, bytes: info.size, fileName: basename(absolute) };
}

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    abortIfNeeded(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function readFileLimited(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  abortIfNeeded(signal);
  const info = await stat(path);
  if (info.size > maxBytes) {
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "文件超过读取容量上限", {
      details: { path, bytes: info.size, maxBytes },
    });
  }
  const data = await readFile(path);
  abortIfNeeded(signal);
  return data;
}

export async function readHead(path: string, bytes = 512): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const result = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export interface StagedCopy {
  readonly stagedPath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export async function stageFileByHash(args: {
  readonly sourcePath: string;
  readonly stagingDir: string;
  readonly extension: string;
  readonly signal?: AbortSignal | undefined;
  readonly hash?: string;
  readonly bytes?: number;
}): Promise<StagedCopy> {
  abortIfNeeded(args.signal);
  const mediaDir = join(args.stagingDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const info = await stat(args.sourcePath);
  const hash = args.hash ?? (await sha256File(args.sourcePath, args.signal));
  const safeExtension = normalizeExtension(args.extension);
  const fileName = `${hash}${safeExtension}`;
  const destination = join(mediaDir, fileName);
  const relativePath = toPosix(relative(args.stagingDir, destination));

  try {
    const existing = await stat(destination);
    if (existing.size !== info.size) {
      throw new LocalAdapterError("INTERNAL_ERROR", "同 hash staging 文件大小不一致");
    }
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await copyFile(args.sourcePath, temporary);
    try {
      await lstat(destination);
      await unlink(temporary);
    } catch (renameError: unknown) {
      if (!isMissingPathError(renameError)) throw renameError;
      const { rename } = await import("node:fs/promises");
      await rename(temporary, destination);
    }
  }

  return {
    stagedPath: relativePath,
    sha256: hash,
    bytes: info.size,
  };
}

export function normalizeExtension(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^.a-z0-9]/gu, "");
  if (cleaned === "" || cleaned === ".") return "";
  return cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
}

export function extensionForPath(path: string): string {
  return normalizeExtension(extname(path));
}

export function toPosix(value: string): string {
  return value.split(sep).join("/");
}

export function makeId(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function oneLine(value: string, max = 120): string {
  const text = normalizeText(value).replace(/\n+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

export function contextBefore(paragraphs: readonly string[], index: number): string {
  const selected = paragraphs.slice(Math.max(0, index - 2), Math.max(0, index));
  return contextSlice(selected.join("\n"), "before");
}

export function contextAfter(paragraphs: readonly string[], index: number): string {
  const selected = paragraphs.slice(Math.max(0, index), Math.max(0, index) + 2);
  return contextSlice(selected.join("\n"), "after");
}

function contextSlice(text: string, direction: "before" | "after"): string {
  if (text.length <= 1_000) return text;
  const kept = direction === "before" ? text.slice(-999) : text.slice(0, 999);
  const valid = direction === "before"
    ? kept.replace(/^[\uDC00-\uDFFF]/u, "")
    : kept.replace(/[\uD800-\uDBFF]$/u, "");
  return direction === "before" ? `…${valid}` : `${valid}…`;
}

export function pageContext(paragraphs: readonly string[]): {
  beforeText: string;
  afterText: string;
} {
  const split = Math.min(2, paragraphs.length);
  return {
    beforeText: contextSlice(paragraphs.slice(0, split).join("\n"), "after"),
    afterText: contextSlice(paragraphs.slice(split, split + 2).join("\n"), "after"),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecordArray(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

export function attribute(node: unknown, name: string): string | null {
  if (!isRecord(node)) return null;
  const value = node[name];
  return typeof value === "string" ? value : null;
}

export function child(node: unknown, name: string): unknown {
  return isRecord(node) ? node[name] : undefined;
}

export function collectText(value: unknown, tagName: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, tagName));
  if (typeof value === "string") return [];
  if (!isRecord(value)) return [];
  const result: string[] = [];
  for (const [key, childValue] of Object.entries(value)) {
    if (key === tagName) {
      if (typeof childValue === "string") result.push(childValue);
      else result.push(...stringsFromTextNodes(childValue));
    } else {
      result.push(...collectText(childValue, tagName));
    }
  }
  return result;
}

function stringsFromTextNodes(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsFromTextNodes);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(stringsFromTextNodes);
}

export function detectMime(head: Buffer, fileName: string): { mime: string; mediaKind: MediaKind } {
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return { mime: "image/png", mediaKind: "image" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: "image/jpeg", mediaKind: "image" };
  }
  if (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { mime: "image/gif", mediaKind: "gif" };
  }
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", mediaKind: "image" };
  }
  if (head.subarray(0, 4).toString("ascii") === "%PDF") {
    return { mime: "application/pdf", mediaKind: "other" };
  }
  if (head.subarray(4, 8).toString("ascii") === "ftyp") {
    return { mime: "video/mp4", mediaKind: "video" };
  }
  if (head.subarray(0, 4).toString("ascii") === "ID3" || head[0] === 0xff) {
    return { mime: "audio/mpeg", mediaKind: "audio" };
  }

  const extension = extname(fileName).toLowerCase();
  const byExtension: Record<string, { mime: string; mediaKind: MediaKind }> = {
    ".png": { mime: "image/png", mediaKind: "image" },
    ".jpg": { mime: "image/jpeg", mediaKind: "image" },
    ".jpeg": { mime: "image/jpeg", mediaKind: "image" },
    ".gif": { mime: "image/gif", mediaKind: "gif" },
    ".webp": { mime: "image/webp", mediaKind: "image" },
    ".svg": { mime: "image/svg+xml", mediaKind: "image" },
    ".mp4": { mime: "video/mp4", mediaKind: "video" },
    ".mov": { mime: "video/quicktime", mediaKind: "video" },
    ".m4v": { mime: "video/x-m4v", mediaKind: "video" },
    ".mp3": { mime: "audio/mpeg", mediaKind: "audio" },
    ".wav": { mime: "audio/wav", mediaKind: "audio" },
  };
  return byExtension[extension] ?? { mime: "application/octet-stream", mediaKind: "other" };
}

export function isMissingPathError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error["code"] === "ENOENT";
}

export async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
  }
}

export async function waitForStream(stream: NodeJS.ReadableStream): Promise<void> {
  await once(stream, "end");
}
