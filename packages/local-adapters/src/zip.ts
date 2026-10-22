import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { LocalAdapterError, type ExtractionLimits } from "./contracts.js";
import { abortIfNeeded, isRecord } from "./util.js";

export interface ZipEntry {
  readonly name: string;
  readonly tempPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly declaredBytes: number | null;
}

export interface ZipStats {
  readonly entryCount: number;
  readonly selectedCount: number;
  readonly declaredExpandedBytes: number;
  readonly actualExpandedBytes: number;
}

export class ZipArchive {
  readonly sourcePath: string;
  readonly workDir: string;
  readonly entries: ReadonlyMap<string, ZipEntry>;
  readonly stats: ZipStats;

  constructor(args: {
    readonly sourcePath: string;
    readonly workDir: string;
    readonly entries: ReadonlyMap<string, ZipEntry>;
    readonly stats: ZipStats;
  }) {
    this.sourcePath = args.sourcePath;
    this.workDir = args.workDir;
    this.entries = args.entries;
    this.stats = args.stats;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  entry(name: string): ZipEntry | null {
    return this.entries.get(name) ?? null;
  }

  readText(name: string, signal?: AbortSignal): string {
    const entry = this.entry(name);
    if (entry === null) {
      throw new LocalAdapterError("SOURCE_UNREADABLE", `ZIP 缺少必需条目 ${name}`, {
        details: { name },
      });
    }
    const data = readFileSync(entry.tempPath);
    abortIfNeeded(signal);
    if (data.includes(0)) {
      throw new LocalAdapterError("SOURCE_UNREADABLE", `ZIP 条目不是 UTF-8 文本 ${name}`);
    }
    const text = data.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
      throw new LocalAdapterError("SOURCE_UNREADABLE", `XML 含被禁止的 DOCTYPE 或 ENTITY ${name}`);
    }
    return text;
  }

  async cleanup(): Promise<void> {
    await rm(this.workDir, { recursive: true, force: true });
  }
}

export async function openZip(args: {
  readonly sourcePath: string;
  readonly inputBytes: number;
  readonly stagingDir: string;
  readonly signal?: AbortSignal | undefined;
  readonly limits: ExtractionLimits;
  readonly select: (name: string) => boolean;
}): Promise<ZipArchive> {
  abortIfNeeded(args.signal);
  const workDir = join(
    args.stagingDir,
    ".zip-work",
    `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(workDir, { recursive: true });

  const entries = new Map<string, ZipEntry>();
  const names = new Set<string>();
  let entryCount = 0;
  let selectedCount = 0;
  let declaredExpandedBytes = 0;
  let actualExpandedBytes = 0;
  let currentFd: number | null = null;
  let failure: Error | null = null;

  const countActualChunk = (name: string, bytes: number): void => {
    if (bytes <= 0) return;
    actualExpandedBytes += bytes;
    if (actualExpandedBytes > args.limits.maxExpandedBytes) {
      throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 总实际解压尺寸超过上限", {
        details: { name, actualExpandedBytes },
      });
    }
    if (actualExpandedBytes > args.inputBytes * args.limits.maxExpansionRatio) {
      throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 实际解压膨胀比超过上限", {
        details: { name, actualExpandedBytes, inputBytes: args.inputBytes },
      });
    }
  };

  const fail = (error: unknown): never => {
    if (error instanceof Error) throw error;
    throw new LocalAdapterError("INTERNAL_ERROR", "ZIP 读取失败", { cause: error });
  };

  const closeCurrent = (): void => {
    if (currentFd !== null) {
      closeSync(currentFd);
      currentFd = null;
    }
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  unzip.onfile = (file: UnzipFile): void => {
    try {
      abortIfNeeded(args.signal);
      entryCount += 1;
      if (entryCount > args.limits.maxArchiveEntries) {
        throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 条目数超过上限", {
          details: { entryCount, maxArchiveEntries: args.limits.maxArchiveEntries },
        });
      }

      const validated = validateEntryName(file.name);
      const duplicateKey = validated.name.normalize("NFC");
      if (names.has(duplicateKey)) {
        throw new LocalAdapterError("PATH_NOT_ALLOWED", `ZIP 含重复条目 ${validated.name}`);
      }
      names.add(duplicateKey);

      const declaredBytes =
        typeof file.originalSize === "number" && Number.isFinite(file.originalSize)
          ? file.originalSize
          : null;
      if (declaredBytes !== null) {
        if (declaredBytes > args.limits.maxExpandedBytes) {
          throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 条目声明解压尺寸超过上限", {
            details: { name: validated.name, declaredBytes },
          });
        }
        declaredExpandedBytes += declaredBytes;
        if (declaredExpandedBytes > args.limits.maxExpandedBytes) {
          throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 总解压尺寸超过上限", {
            details: { declaredExpandedBytes, maxExpandedBytes: args.limits.maxExpandedBytes },
          });
        }
        if (declaredExpandedBytes > args.inputBytes * args.limits.maxExpansionRatio) {
          throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 解压膨胀比超过上限", {
            details: {
              declaredExpandedBytes,
              inputBytes: args.inputBytes,
              maxExpansionRatio: args.limits.maxExpansionRatio,
            },
          });
        }
      }

      if (validated.isDirectory) {
        setDiscardHandler(file, (bytes) => countActualChunk(validated.name, bytes));
        return;
      }

      if (!args.select(validated.name)) {
        setDiscardHandler(file, (bytes) => countActualChunk(validated.name, bytes));
        return;
      }

      selectedCount += 1;
      const tempPath = join(workDir, `entry-${selectedCount}`);
      const fd = openSync(tempPath, "wx", 0o600);
      currentFd = fd;
      const hash = createHash("sha256");
      let bytes = 0;
      let closed = false;

      file.ondata = (_error: Error | null, chunk: Uint8Array, final: boolean): void => {
        try {
          if (_error !== null) {
            throw new LocalAdapterError("SOURCE_UNREADABLE", `ZIP 条目解压失败 ${validated.name}`, {
              cause: _error,
            });
          }
          abortIfNeeded(args.signal);
          if (chunk.length > 0) {
            bytes += chunk.length;
            if (bytes > args.limits.maxExpandedBytes) {
              throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 条目实际解压尺寸超过上限", {
                details: { name: validated.name, bytes },
              });
            }
            countActualChunk(validated.name, chunk.length);
            hash.update(chunk);
            writeSync(fd, chunk);
          }
          if (final) {
            closeCurrent();
            closed = true;
            if (declaredBytes !== null && bytes !== declaredBytes) {
              throw new LocalAdapterError("SOURCE_UNREADABLE", "ZIP 条目大小与声明不一致", {
                details: { name: validated.name, bytes, declaredBytes },
              });
            }
            const sha256 = hash.digest("hex");
            entries.set(validated.name, {
              name: validated.name,
              tempPath,
              bytes,
              sha256,
              declaredBytes,
            });
          }
        } catch (error: unknown) {
          closeCurrent();
          failure = error instanceof Error ? error : new Error(String(error));
          if (!closed) closeCurrent();
          fail(error);
        }
      };

      file.start();
    } catch (error: unknown) {
      closeCurrent();
      failure = error instanceof Error ? error : new Error(String(error));
      fail(error);
    }
  };

  try {
    const handle = await open(args.sourcePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        abortIfNeeded(args.signal);
        const read = await handle.read(buffer, 0, buffer.length, position);
        if (failure !== null) fail(failure);
        if (read.bytesRead === 0) break;
        position += read.bytesRead;
        const chunk = new Uint8Array(
          buffer.buffer,
          buffer.byteOffset,
          read.bytesRead,
        ).slice();
        unzip.push(chunk, false);
      }
      unzip.push(new Uint8Array(0), true);
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    closeCurrent();
    await rm(workDir, { recursive: true, force: true });
    if (error instanceof LocalAdapterError || isAbortError(error)) throw error;
    throw new LocalAdapterError("SOURCE_UNREADABLE", "ZIP 文件无法读取", { cause: error });
  }

  closeCurrent();
  if (failure !== null) {
    await rm(workDir, { recursive: true, force: true });
    fail(failure);
  }
  if (actualExpandedBytes > args.limits.maxExpandedBytes) {
    await rm(workDir, { recursive: true, force: true });
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 完成后复检解压尺寸超限");
  }
  if (actualExpandedBytes > args.inputBytes * args.limits.maxExpansionRatio) {
    await rm(workDir, { recursive: true, force: true });
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 完成后复检膨胀比超限");
  }
  if (entryCount > args.limits.maxArchiveEntries) {
    await rm(workDir, { recursive: true, force: true });
    throw new LocalAdapterError("CAPACITY_EXCEEDED", "ZIP 完成后复检条目数超限");
  }

  return new ZipArchive({
    sourcePath: args.sourcePath,
    workDir,
    entries,
    stats: {
      entryCount,
      selectedCount,
      declaredExpandedBytes,
      actualExpandedBytes,
    },
  });
}

function setDiscardHandler(
  file: UnzipFile,
  onChunk: (bytes: number) => void,
): void {
  file.ondata = (error: Error | null, chunk: Uint8Array, _final: boolean): void => {
    if (error !== null) {
      throw new LocalAdapterError("SOURCE_UNREADABLE", `ZIP 条目解压失败 ${file.name}`, {
        cause: error,
      });
    }
    onChunk(chunk.length);
  };
  file.start();
}

function validateEntryName(rawName: string): { name: string; isDirectory: boolean } {
  if (rawName.length === 0 || rawName.length > 4096) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", "ZIP 条目名为空或过长");
  }
  if (rawName.includes("\\")) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", `ZIP 条目使用反斜杠 ${rawName}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(rawName)) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", "ZIP 条目名含控制字符");
  }
  if (rawName.startsWith("/") || /^[a-z]:/iu.test(rawName) || rawName.includes("://")) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", `ZIP 条目为绝对路径或外链 ${rawName}`);
  }
  const isDirectory = rawName.endsWith("/");
  const trimmed = isDirectory ? rawName.slice(0, -1) : rawName;
  const segments = trimmed.split("/");
  if (
    trimmed === "" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LocalAdapterError("PATH_NOT_ALLOWED", `ZIP 条目包含越界路径 ${rawName}`);
  }
  return { name: rawName, isDirectory };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (isRecord(error) && error["name"] === "AbortError");
}
