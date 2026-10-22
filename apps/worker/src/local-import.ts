import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ImportManifestSchema,
  ItemResultMessageSchema,
  type ImportCheckpoint,
  type ImportItemResult,
  type ImportManifestItem,
  type JobGrant,
  type StagedFile,
} from "@dmall/contracts";
import { sniffMagic, titleFromFileName } from "@dmall/domain";
import { processGif, processImage, processVideo } from "./media.js";
import type { MediaProcessRuntime } from "./media-process.js";
import { RestrictedRoot, RestrictedFileError } from "@dmall/storage";
import { WorkerTaskError } from "./task-error.js";
import { processDocumentItem } from "./document-import.js";

const HASH_BUFFER = 1024 * 1024;

export interface ImportRuntime {
  sendItemResult(message: ReturnType<typeof ItemResultMessageSchema.parse>): Promise<{
    accepted: boolean;
    code: string | null;
  }>;
  emitCheckpoint(checkpoint: ImportCheckpoint): void;
  cancelled(): boolean;
  signal: AbortSignal;
}

export async function runImportJob(
  grant: JobGrant,
  media: MediaProcessRuntime,
  runtime: ImportRuntime,
): Promise<{ committed: number; failed: number }> {
  if (grant.input.jobType !== "local_import") {
    throw new WorkerTaskError("INTERNAL_ERROR", "导入任务输入类型不匹配");
  }
  if (grant.workspacePath === undefined || grant.manifestPath === undefined) {
    throw new WorkerTaskError("INTERNAL_ERROR", "导入任务缺少独立工作目录或输入清单");
  }
  const workspace = resolve(grant.workspacePath);
  const manifest = ImportManifestSchema.parse(
    JSON.parse(await readFile(grant.manifestPath, "utf8")) as unknown,
  );
  if (manifest.scanId !== grant.input.scanId) {
    throw new WorkerTaskError("INTERNAL_ERROR", "导入清单与任务扫描不匹配");
  }
  let committedCount = manifest.items.filter(item => item.state === "committed").length;
  let failed = manifest.items.filter(item => item.state === "failed").length;
  const knownFiles = manifest.items
    .filter((item) => item.kind !== "markdown")
    .map((item) => item.relativePath);

  for (let index = 0; index < manifest.items.length; index += 1) {
    if (runtime.cancelled()) throw new WorkerTaskError("JOB_CANCELLED", "导入已取消");
    const item = manifest.items[index];
    if (item === undefined) break;
    if (item.state === "committed" || item.state === "failed" || item.state === "skipped") {
      continue;
    }
    const itemDirectory = resolve(workspace, "items", item.scanItemId);
    ensureInside(workspace, itemDirectory);
    await mkdir(itemDirectory, { recursive: true });
    let outcome: ImportItemResult;
    let stagedFiles: StagedFile[] = [];
    let mediaBatches: Array<Array<import("@dmall/contracts").StagedDocumentMedia>> = [];
    try {
      if (runtime.cancelled()) throw new WorkerTaskError("JOB_CANCELLED", "导入已取消");
      const result = await processItem(
        item,
        workspace,
        itemDirectory,
        media,
        runtime.signal,
        knownFiles,
      );
      outcome = result.item;
      stagedFiles = result.stagedFiles;
      mediaBatches = result.mediaBatches;
    } catch (error) {
      if (error instanceof WorkerTaskError && error.code === "JOB_CANCELLED") throw error;
      if (runtime.signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "导入已取消");
      const taskError =
        error instanceof RestrictedFileError
          ? new WorkerTaskError(error.code, error.message)
          : error instanceof WorkerTaskError
          ? error
          : new WorkerTaskError("INTERNAL_ERROR", error instanceof Error ? error.message : "导入失败", true);
      outcome = {
        state: "failed",
        scanItemId: item.scanItemId,
        relativePath: item.relativePath,
        errorCode: failureCode(taskError.code),
        message: taskError.message,
        retryable: taskError.retryable,
      };
      stagedFiles = [];
      mediaBatches = [];
    }

    for (const [batchIndex, media] of mediaBatches.entries()) {
      const batchMessage = ItemResultMessageSchema.parse({
        schemaVersion: 1,
        type: "item_result",
        messageId: randomUUID(),
        fence: grant.fence,
        kind: "document_media_batch",
        batch: {
          scanItemId: item.scanItemId,
          batchIndex,
          batchCount: mediaBatches.length,
          media,
        },
        stagedFiles: [],
      });
      const batchAck = await runtime.sendItemResult(batchMessage);
      if (!batchAck.accepted) {
        throw new WorkerTaskError(
          "JOB_STALE_LEASE",
          `文档媒体批次未被 API 接受：${batchAck.code ?? "UNKNOWN"}`,
        );
      }
    }

    const message = ItemResultMessageSchema.parse({
      schemaVersion: 1,
      type: "item_result",
      messageId: randomUUID(),
      fence: grant.fence,
      kind: "import_item",
      item: outcome,
      stagedFiles,
    });
    const ack = await runtime.sendItemResult(message);
    if (!ack.accepted) {
      throw new WorkerTaskError("JOB_STALE_LEASE", `导入结果未被 API 接受：${ack.code ?? "UNKNOWN"}`);
    }
    if (outcome.state === "failed") {
      failed += 1;
    } else {
      committedCount += 1;
      runtime.emitCheckpoint({
        schemaVersion: 1,
        jobType: "local_import",
        pipelineVersion: "dcw-local-import/1",
        scanId: manifest.scanId,
        manifestHash: manifest.manifestHash,
        lastCommittedItemId: item.scanItemId,
      });
    }
    await rm(itemDirectory, { recursive: true, force: true });
  }

  return { committed: committedCount, failed };
}

async function processItem(
  item: ImportManifestItem,
  workspace: string,
  itemDirectory: string,
  media: MediaProcessRuntime,
  signal: AbortSignal,
  knownFiles: readonly string[],
): Promise<{
  item: Extract<ImportItemResult, { state: "committed" }>;
  stagedFiles: StagedFile[];
  mediaBatches: Array<Array<import("@dmall/contracts").StagedDocumentMedia>>;
}> {
  const extension = extname(item.relativePath).toLowerCase();
  const originalName = `original${extension === "" ? "" : extension}`;
  const originalPath = join(itemDirectory, originalName);
  const boundary = await RestrictedRoot.capture(item.rootPath);
  const original = await boundary.withFile({
    path: relative(item.rootPath, item.sourcePath),
    ...(item.pathIdentity === undefined ? {} : {parents: item.pathIdentity}),
    expected: item,
    read: async ({handle, verify}) => {
      const destination = await open(originalPath, "wx", 0o600);
      const buffer = Buffer.alloc(HASH_BUFFER);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        while (true) {
          await verify();
          const {bytesRead} = await handle.read(buffer, 0, buffer.length, bytes);
          await verify();
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          bytes += bytesRead;
          await destination.writeFile(chunk);
        }
        await destination.sync();
        return {sha256: hash.digest("hex"), bytes};
      } finally { await destination.close(); }
    },
  });
  if (item.bytes > 0 && original.bytes !== item.bytes) {
    throw new WorkerTaskError("SOURCE_UNREADABLE", "复制后的字节数与扫描结果不一致");
  }
  if (item.sha256 !== null && original.sha256 !== item.sha256) {
    throw new WorkerTaskError(
      "SOURCE_CHANGED_RESCAN_REQUIRED",
      "暂存文件 hash 与上传完成时不一致，请重新扫描",
    );
  }

  const originalWorkspacePath = toWorkspaceRelative(workspace, originalPath);
  const originalMime = item.mime ?? "application/octet-stream";
  if (
    item.kind === "markdown" ||
    item.kind === "html" ||
    item.kind === "html_zip" ||
    item.kind === "pdf" ||
    item.kind === "pptx"
  ) {
    return processDocumentItem({
      item,
      originalPath,
      itemDirectory,
      workspace,
      knownFiles,
      signal,
      originalSha256: original.sha256,
      originalBytes: original.bytes,
      originalMime,
      originalWorkspacePath,
    });
  }
  const stagedFiles: StagedFile[] = [
    {
      role: "original",
      relativePath: originalWorkspacePath,
      sha256: original.sha256,
      bytes: original.bytes,
      mime: originalMime,
    },
  ];
  if (item.mime === null) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "缺少魔数识别出的 MIME");
  }
  const header = await readHeader(originalPath);
  const magic = sniffMagic(header, item.relativePath, null);
  if (magic.kind !== item.kind || magic.mime !== item.mime) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", "文件魔数与扫描结果不一致");
  }
  const posterPath = join(itemDirectory, "poster.webp");
  if (item.kind === "image") {
    const processed = await processImage(originalPath, posterPath);
    const poster = await fileDescriptor(workspace, posterPath, "poster", "image/webp");
    stagedFiles.push(poster);
    return {
      item: committedMedia(item, original, processed.probe, {
        imagePosterRecipe: "dcw-image-poster/1",
        magicSniffer: "dcw-magic/1",
      }),
      stagedFiles,
      mediaBatches: [],
    };
  }
  if (item.kind === "gif") {
    const processed = await processGif(originalPath, posterPath);
    stagedFiles.push(await fileDescriptor(workspace, posterPath, "poster", "image/webp"));
    return {
      item: committedMedia(item, original, processed.probe, {
        gifPosterRecipe: "dcw-gif-poster/1",
        magicSniffer: "dcw-magic/1",
      }),
      stagedFiles,
      mediaBatches: [],
    };
  }
  if (item.kind === "video") {
    const previewPath = join(itemDirectory, "preview.mp4");
    const processed = await processVideo({
      sourcePath: originalPath,
      posterPngPath: join(itemDirectory, "poster.png"),
      posterPath,
      previewPath,
      media,
      signal,
    });
    stagedFiles.push(await fileDescriptor(workspace, posterPath, "poster", "image/webp"));
    stagedFiles.push(await fileDescriptor(workspace, previewPath, "video_preview", "video/mp4"));
    return {
      item: committedMedia(item, original, processed.probe, {
        ffprobe: "ffprobe/8.1",
        ffmpegPosterRecipe: "dcw-video-poster/1",
        ffmpegPreviewRecipe: "dcw-video-preview/1",
        magicSniffer: "dcw-magic/1",
      }),
      stagedFiles,
      mediaBatches: [],
    };
  }
  throw new WorkerTaskError("UNSUPPORTED_FORMAT", "不支持的导入类型");
}

function committedMedia(
  item: ImportManifestItem,
  original: { sha256: string; bytes: number },
  probe: NonNullable<Extract<ImportItemResult, { state: "committed" }>["probe"]>,
  processorVersions: Record<string, string>,
): Extract<ImportItemResult, { state: "committed" }> {
  return {
    state: "committed",
    scanItemId: item.scanItemId,
    relativePath: item.relativePath,
    kind: item.kind === "image" || item.kind === "gif" || item.kind === "video" ? item.kind : "image",
    title: titleFromFileName(basename(item.relativePath)),
    sha256: original.sha256,
    bytes: original.bytes,
    mime: item.mime ?? "application/octet-stream",
    processorVersions,
    probe,
    markdownOccurrences: [],
  };
}

async function fileDescriptor(
  workspace: string,
  path: string,
  role: "poster" | "video_preview",
  mime: string,
): Promise<StagedFile> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size === 0) {
    throw new WorkerTaskError("UNSUPPORTED_FORMAT", `${role} 输出为空`);
  }
  const hash = await hashFileStreaming(path);
  return {
    role,
    relativePath: toWorkspaceRelative(workspace, path),
    sha256: hash,
    bytes: stats.size,
    mime,
  };
}

async function hashFileStreaming(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: HASH_BUFFER })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function toWorkspaceRelative(workspace: string, path: string): string {
  ensureInside(workspace, path);
  return relative(workspace, path).split("\\").join("/");
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path.startsWith("..") || isAbsolute(path)) {
    throw new WorkerTaskError("PATH_NOT_ALLOWED", "暂存路径越出任务工作目录");
  }
}

function failureCode(code: string): Extract<ImportItemResult, { state: "failed" }>["errorCode"] {
  switch (code) {
    case "SOURCE_CHANGED_RESCAN_REQUIRED":
    case "SOURCE_UNREADABLE":
    case "MISSING_DEPENDENCY":
    case "UNSUPPORTED_FORMAT":
    case "PATH_NOT_ALLOWED":
    case "SYMLINK_OUTSIDE_ROOT":
    case "DISK_FULL":
      return code;
    case "CAPACITY_EXCEEDED":
      return "DISK_FULL";
    default:
      return "INTERNAL_ERROR";
  }
}
