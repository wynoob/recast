import { createHash, randomUUID } from "node:crypto";
import { open, lstat, readlink, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  ScanCheckpointSchema,
  ScanItemResultSchema,
  UploadScanManifestSchema,
  type JobGrant,
  type ScanCheckpoint,
  type ScanCounts,
  type ScanItemResult,
} from "@dmall/contracts";
import { sniffMagic } from "@dmall/domain";
import { RestrictedRoot, decodeUtf8Sample, type PathIdentity } from "@dmall/storage";
import { WorkerTaskError } from "./task-error.js";

const HEADER_BYTES = 65_536;
const SINGLE_FILE_LIMIT = 2 * 1024 * 1024 * 1024;
const BATCH_LIMIT = 10 * 1024 * 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  ".venv",
  ".idea",
  ".vscode",
  "node_modules",
  "build",
  "dist",
  "renders",
  "render",
  "__pycache__",
  "venv",
]);

const EXCLUDED_FILE_PATTERNS = [
  ".ds_store",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "credentials",
  "credentials.*",
  "*.sqlite",
  "*.sqlite-wal",
  "*.sqlite-shm",
  "*.part",
  "*.tmp",
].map(globToRegExp);

export interface ScanRuntime {
  emitItem(item: ScanItemResult): Promise<void>;
  emitCheckpoint(checkpoint: ScanCheckpoint): void;
  cancelled(): boolean;
}

export async function runScanJob(grant: JobGrant, runtime: ScanRuntime): Promise<{
  counts: ScanCounts;
  manifestHash: string;
}> {
  if (grant.input.jobType !== "local_scan") {
    throw new WorkerTaskError("INTERNAL_ERROR", "扫描任务输入类型不匹配");
  }
  if (grant.input.sourceKind === "upload") {
    if (grant.manifestPath === undefined) {
      throw new WorkerTaskError("INTERNAL_ERROR", "上传扫描缺少输入清单");
    }
    return runUploadScan(grant, runtime);
  }
  return runDirectoryScan(grant.input.rootPath, grant, runtime);
}

async function runDirectoryScan(
  rootPathInput: string,
  grant: JobGrant,
  runtime: ScanRuntime,
): Promise<{ counts: ScanCounts; manifestHash: string }> {
  if (!isAbsolute(rootPathInput)) {
    throw new WorkerTaskError("PATH_NOT_ALLOWED", "扫描根必须是绝对路径");
  }
  const realRoot = await realpath(rootPathInput).catch(() => {
    throw new WorkerTaskError("SOURCE_UNREADABLE", "扫描根不存在或不可读");
  });
  const rootStats = await lstat(realRoot);
  if (!rootStats.isDirectory()) {
    throw new WorkerTaskError("SOURCE_UNREADABLE", "扫描根不是目录");
  }
  const boundary = await RestrictedRoot.capture(realRoot, grant.input.jobType === "local_scan" && grant.input.sourceKind === "local_directory" ? grant.input.rootPathIdentity : undefined);
  const directoryIdentities = new Map<string, PathIdentity[]>([["", [...boundary.identity]]]);
  const rootIdentity = sha256Text(realRoot);
  const counts = zeroCounts();
  let nextOrdinal = 0;
  const stack = [""];
  const fingerprints: string[] = [];
  let visitedDirectoryCount = 0;

  while (stack.length > 0) {
    if (runtime.cancelled()) {
      throw new WorkerTaskError("JOB_CANCELLED", "扫描已取消");
    }
    const directory = stack.pop();
    if (directory === undefined) break;
    const absoluteDirectory = directory === "" ? realRoot : resolve(realRoot, directory);
    if (!isInside(realRoot, absoluteDirectory)) {
      throw new WorkerTaskError("PATH_NOT_ALLOWED", "目录越出扫描根");
    }
    runtime.emitCheckpoint(
      ScanCheckpointSchema.parse({
        schemaVersion: 1,
        jobType: "local_scan",
        scannerVersion: "dcw-directory-scan/1",
        rootIdentity,
        stack: [...stack, directory],
        nextOrdinal,
        visitedDirectoryCount,
        candidateCount: counts.candidate,
        excludedCount: counts.excluded,
        unsupportedCount: counts.unsupported + counts.unreadable,
        totalBytes: counts.totalBytes,
        itemDigest: sha256Text(fingerprints.sort().join("\n")),
      }),
    );
    const entries = await boundary.list(directory, directoryIdentities.get(directory)).catch(() => {
      throw new WorkerTaskError("SOURCE_UNREADABLE", "目录不可读");
    });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    const childDirectories: string[] = [];
    for (const entry of entries) {
      const relativePath = toPosix(directory === "" ? entry.name : `${directory}/${entry.name}`);
      if (!isSafeRelative(relativePath)) {
        counts.unreadable += 1;
        continue;
      }
      const absolutePath = resolve(realRoot, ...relativePath.split("/"));
      let stats: Stats;
      try {
        stats = await boundary.stat(relativePath);
      } catch {
        counts.unreadable += 1;
        await runtime.emitItem(await unreadableItem(relativePath, entry.name, "SOURCE_UNREADABLE"));
        continue;
      }
      if (stats.isSymbolicLink()) {
        const outside = await symlinkEscapes(realRoot, absolutePath);
        counts.excluded += 1;
        await runtime.emitItem(
          await metadataItem({
            relativePath,
            absolutePath,
            stats,
            ordinal: nextOrdinal++,
            status: "excluded",
            exclusionCode: outside ? "SYMLINK_OUTSIDE_ROOT" : "SYMLINK_NOT_FOLLOWED",
          }),
        );
        continue;
      }
      if (stats.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          counts.excluded += 1;
          await runtime.emitItem(
            await metadataItem({
              relativePath,
              absolutePath,
              stats,
              ordinal: nextOrdinal++,
              status: "excluded",
              exclusionCode: "EXCLUDED_DIRECTORY",
            }),
          );
        } else {
          directoryIdentities.set(relativePath, await boundary.directoryIdentity(relativePath));
          childDirectories.push(relativePath);
        }
        continue;
      }
      if (!stats.isFile()) {
        counts.unsupported += 1;
        await runtime.emitItem(
          await metadataItem({
            relativePath,
            absolutePath,
            stats,
            ordinal: nextOrdinal++,
            status: "unsupported",
            exclusionCode: "UNSUPPORTED_FILE_TYPE",
          }),
        );
        continue;
      }
      if (isExcludedFile(entry.name)) {
        counts.excluded += 1;
        await runtime.emitItem(
          await metadataItem({
            relativePath,
            absolutePath,
            stats,
            ordinal: nextOrdinal++,
            status: "excluded",
            exclusionCode: "EXCLUDED_FILE",
          }),
        );
        continue;
      }
      if (stats.size > SINGLE_FILE_LIMIT) {
        counts.excluded += 1;
        await runtime.emitItem(
          await metadataItem({
            relativePath,
            absolutePath,
            stats,
            ordinal: nextOrdinal++,
            status: "excluded",
            exclusionCode: "SINGLE_FILE_LIMIT",
          }),
        );
        continue;
      }

      let header: Buffer;
      let textSample: string | null;
      let pathIdentity: PathIdentity[];
      try {
        ({ header, textSample, pathIdentity } = await readRestrictedHeader(boundary, relativePath, stats));
      } catch {
        counts.unreadable += 1;
        await runtime.emitItem(await unreadableItem(relativePath, entry.name, "SOURCE_UNREADABLE"));
        continue;
      }
      const magic = sniffMagic(header, entry.name, textSample);
      const item =
        magic.kind === "unsupported"
          ? await metadataItem({
              relativePath,
              absolutePath,
              stats,
              ordinal: nextOrdinal++,
              status: "unsupported",
              exclusionCode: "UNSUPPORTED_FORMAT",
              magicPrefixHex: Buffer.from(header.subarray(0, 32)).toString("hex"),
            })
          : ScanItemResultSchema.parse({
              scanItemId: randomUUID(),
              relativePath,
              basename: entry.name,
              kind: magic.kind,
              mime: magic.mime,
              bytes: stats.size,
              mtimeMs: stats.mtimeMs,
              deviceId: String(stats.dev),
              inode: String(stats.ino),
              magicPrefixHex: Buffer.from(header.subarray(0, 32)).toString("hex"),
              status: "candidate",
              exclusionCode: null,
              metadata: {
                extensionMismatch: magic.extensionMismatch,
                extension: magic.extension,
                pathIdentity,
              },
            });
      if (item.status === "candidate") {
        counts.candidate += 1;
        counts.totalBytes += item.bytes;
        incrementKindCount(counts, magic.kind);
        fingerprints.push(
          `${item.relativePath}:${item.bytes}:${item.mtimeMs}:${String(item.deviceId)}:${item.inode}`,
        );
        if (counts.totalBytes > BATCH_LIMIT) {
          throw new WorkerTaskError("CAPACITY_EXCEEDED", "本批次文件总量超过 10GiB");
        }
      } else if (item.status === "unsupported") {
        counts.unsupported += 1;
      }
      await runtime.emitItem(item);
    }
    visitedDirectoryCount += 1;
    for (const child of [...childDirectories].reverse()) stack.push(child);
    runtime.emitCheckpoint(
      ScanCheckpointSchema.parse({
        schemaVersion: 1,
        jobType: "local_scan",
        scannerVersion: "dcw-directory-scan/1",
        rootIdentity,
        stack: [...stack],
        nextOrdinal,
        visitedDirectoryCount,
        candidateCount: counts.candidate,
        excludedCount: counts.excluded,
        unsupportedCount: counts.unsupported + counts.unreadable,
        totalBytes: counts.totalBytes,
        itemDigest: sha256Text(fingerprints.sort().join("\n")),
      }),
    );
  }

  return {
    counts,
    manifestHash: sha256Text(fingerprints.sort().join("\n")),
  };
}

async function runUploadScan(
  grant: JobGrant,
  runtime: ScanRuntime,
): Promise<{ counts: ScanCounts; manifestHash: string }> {
  if (grant.manifestPath === undefined) {
    throw new WorkerTaskError("INTERNAL_ERROR", "上传扫描缺少输入清单");
  }
  const manifest = UploadScanManifestSchema.parse(
    JSON.parse(await readTextFile(grant.manifestPath)),
  );
  const counts = zeroCounts();
  const fingerprints: string[] = [];
  for (const [ordinal, file] of manifest.files.entries()) {
    if (runtime.cancelled()) throw new WorkerTaskError("JOB_CANCELLED", "扫描已取消");
    const stats = await lstat(file.sourcePath);
    const { header, textSample } = await readHeader(file.sourcePath, basename(file.relativePath));
    const magic = sniffMagic(header, basename(file.relativePath), textSample);
    const item = ScanItemResultSchema.parse({
      scanItemId: randomUUID(),
      relativePath: file.relativePath,
      basename: basename(file.relativePath),
      kind: magic.kind,
      mime: magic.mime,
      bytes: stats.size,
      mtimeMs: stats.mtimeMs,
      deviceId: String(stats.dev),
      inode: String(stats.ino),
      magicPrefixHex: Buffer.from(header.subarray(0, 32)).toString("hex"),
      status: magic.kind === "unsupported" ? "unsupported" : "candidate",
      exclusionCode: magic.kind === "unsupported" ? "UNSUPPORTED_FORMAT" : null,
      metadata: {
        extensionMismatch: magic.extensionMismatch,
        extension: magic.extension,
      },
    });
    if (item.status === "candidate") {
      counts.candidate += 1;
      counts.totalBytes += item.bytes;
      incrementKindCount(counts, magic.kind);
      fingerprints.push(`${item.relativePath}:${item.bytes}:${item.mtimeMs}`);
    } else {
      counts.unsupported += 1;
    }
    await runtime.emitItem(item);
    runtime.emitCheckpoint(
      ScanCheckpointSchema.parse({
        schemaVersion: 1,
        jobType: "local_scan",
        scannerVersion: "dcw-directory-scan/1",
        rootIdentity: manifest.uploadSetId,
        stack: [],
        nextOrdinal: ordinal + 1,
        visitedDirectoryCount: 1,
        candidateCount: counts.candidate,
        excludedCount: counts.excluded,
        unsupportedCount: counts.unsupported,
        totalBytes: counts.totalBytes,
        itemDigest: sha256Text(fingerprints.join("\n")),
      }),
    );
  }
  return { counts, manifestHash: sha256Text(fingerprints.join("\n")) };
}

async function metadataItem(input: {
  relativePath: string;
  absolutePath: string;
  stats: Stats;
  ordinal: number;
  status: "excluded" | "unsupported" | "unreadable";
  exclusionCode: string;
  magicPrefixHex?: string;
}): Promise<ScanItemResult> {
  const headerHex = input.magicPrefixHex ?? "";
  return ScanItemResultSchema.parse({
    scanItemId: randomUUID(),
    relativePath: input.relativePath,
    basename: basename(input.relativePath),
    kind: "unsupported",
    mime: null,
    bytes: input.stats.size,
    mtimeMs: input.stats.mtimeMs,
    deviceId: String(input.stats.dev),
    inode: String(input.stats.ino),
    magicPrefixHex: headerHex,
    status: input.status,
    exclusionCode: input.exclusionCode,
    metadata: {
      extensionMismatch: false,
      extension: "",
    },
  });
}

async function unreadableItem(
  relativePath: string,
  name: string,
  code: string,
): Promise<ScanItemResult> {
  return ScanItemResultSchema.parse({
    scanItemId: randomUUID(),
    relativePath,
    basename: name,
    kind: "unsupported",
    mime: null,
    bytes: 0,
    mtimeMs: 0,
    deviceId: "0",
    inode: "0",
    magicPrefixHex: "",
    status: "unreadable",
    exclusionCode: code,
    metadata: { extensionMismatch: false, extension: "" },
  });
}

async function readRestrictedHeader(boundary: RestrictedRoot, path: string, expected: Stats) {
  return boundary.withFile({ path, expected: {deviceId: String(expected.dev), inode: String(expected.ino), bytes: expected.size, mtimeMs: expected.mtimeMs}, read: async ({handle, stats, parents, verify}) => {
    const buffer = Buffer.alloc(HEADER_BYTES);
    await verify();
    const {bytesRead} = await handle.read(buffer, 0, HEADER_BYTES, 0);
    await verify();
    const header = buffer.subarray(0, bytesRead);
    const textSample = /\.(md|markdown|html?|htm)$/iu.test(path)
      ? decodeUtf8Sample(header, bytesRead >= stats.size)
      : null;
    return {header, textSample, pathIdentity: parents};
  }});
}

async function readHeader(path: string, fileName: string): Promise<{
  header: Buffer;
  textSample: string | null;
}> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const header = buffer.subarray(0, bytesRead);
    let textSample: string | null = null;
    if (/\.(md|markdown|html?|htm)$/iu.test(fileName)) {
      try {
        textSample = decodeUtf8Sample(header, bytesRead >= (await handle.stat()).size);
      } catch {
        throw new WorkerTaskError("SOURCE_UNREADABLE", "Markdown 不是有效 UTF-8");
      }
    }
    return { header, textSample };
  } finally {
    await handle.close();
  }
}

async function symlinkEscapes(root: string, linkPath: string): Promise<boolean> {
  try {
    const target = await readlink(linkPath);
    const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
    const resolved = await realpath(absoluteTarget);
    return !isInside(root, resolved);
  } catch {
    return true;
  }
}

function isExcludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(lower));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = [...pattern]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[\\^$.[\]{}()+|]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`, "u");
}

function isSafeRelative(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function toPosix(value: string): string {
  return value.split(sep).join(posix.sep);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function zeroCounts(): ScanCounts {
  return {
    candidate: 0,
    excluded: 0,
    unsupported: 0,
    unreadable: 0,
    mp4: 0,
    gif: 0,
    image: 0,
    markdown: 0,
    pdf: 0,
    pptx: 0,
    html: 0,
    htmlZip: 0,
    totalBytes: 0,
  };
}

function incrementKindCount(
  counts: ScanCounts,
  kind: ScanItemResult["kind"],
): void {
  switch (kind) {
    case "image":
      counts.image += 1;
      return;
    case "gif":
      counts.gif += 1;
      return;
    case "video":
      counts.mp4 += 1;
      return;
    case "markdown":
      counts.markdown += 1;
      return;
    case "pdf":
      counts.pdf += 1;
      return;
    case "pptx":
      counts.pptx += 1;
      return;
    case "html":
      counts.html += 1;
      return;
    case "html_zip":
      counts.htmlZip += 1;
      return;
    case "unsupported":
      return;
  }
}

async function readTextFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
