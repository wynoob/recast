import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ImportManifestSchema, JobGrantSchema, UploadScanManifestSchema, type JobGrant } from "@dmall/contracts";
import type { BlobStore } from "@dmall/storage";
import type { ImportRepository, UploadSessionRecord } from "./import-repository.js";
import type { JobRepository } from "./job-repository.js";
import { ApiError } from "./errors.js";
export class ImportExecution {
  constructor(private readonly dataRoot: string, private readonly imports: ImportRepository, private readonly blobs: BlobStore, private readonly jobs: JobRepository) { }
  async prepareGrant(grant: JobGrant): Promise<JobGrant> {
    if (!this.jobs.isFenceValid(grant.fence))
      throw staleLease();
    const workspacePath = join(this.dataRoot, "staging", "jobs", grant.jobId, `${grant.fence.attempt}-${grant.fence.leaseGeneration}`);
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    if (grant.input.jobType === "local_scan") {
      this.imports.setScanStatus(grant.input.scanId, "scanning");
      if (grant.input.sourceKind === "upload") {
        const manifestPath = join(workspacePath, "input-manifest.json");
        const sessions = this.imports.uploadSessionsForScan(grant.input.scanId);
        const manifest = UploadScanManifestSchema.parse({
          schemaVersion: 1,
          jobType: "local_scan",
          sourceKind: "upload",
          uploadSetId: sha256Text([...grant.input.fileIds].sort().join("\n")),
          files: sessions.map((session) => ({
            fileId: session.id,
            relativePath: session.relativePath,
            sourcePath: this.blobs.resolveRelativePath(session.stagingRelativePath),
            sha256: session.sha256,
            bytes: session.receivedBytes,
            mime: session.mime,
          })),
        });
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
        return JobGrantSchema.parse({ ...grant, workspacePath, manifestPath });
      }
      return JobGrantSchema.parse({ ...grant, workspacePath });
    }
    if (grant.input.jobType === "local_import") {
      const scan = this.imports.requireScan(grant.input.scanId);
      if (scan.rootPath === null && scan.sourceKind === "local_directory") {
        throw staleLease();
      }
      const manifestPath = join(workspacePath, "input-manifest.json");
      const items = this.imports.executionItems(grant.jobId);
      const sessions = scan.sourceKind === "upload" ? this.imports.uploadSessionsForScan(scan.id) : [];
      const sessionByPath = new Map(sessions.map((session) => [session.relativePath, session]));
      const manifest = ImportManifestSchema.parse({
        schemaVersion: 1,
        jobType: "local_import",
        scanId: scan.id,
        manifestHash: scan.manifestHash ?? sha256Text(""),
        items: items.map((importItem) => {
          const scanItem = this.imports.requireScanItem(importItem.scanItemId);
          if (scan.sourceKind === "local_directory" && scanItem.metadata.pathIdentity === undefined) {
            throw new ApiError({ statusCode: 409, code: "SOURCE_CHANGED_RESCAN_REQUIRED", message: "旧扫描缺少目录身份，请重新扫描" });
          }
          const sourcePath = scan.sourceKind === "local_directory"
            ? resolve(scan.rootPath ?? "", ...scanItem.relativePath.split("/"))
            : this.uploadSourcePath(sessionByPath, scanItem.relativePath);
          return {
            scanItemId: scanItem.id,
            relativePath: scanItem.relativePath,
            rootPath: scan.sourceKind === "local_directory" ? (scan.rootPath ?? "") : join(this.dataRoot, "staging", "uploads"),
            sourcePath,
            bytes: scanItem.bytes,
            mtimeMs: scanItem.mtimeMs,
            deviceId: scanItem.deviceId,
            inode: scanItem.inode,
            kind: scanItem.mediaKindGuess === "image" ||
              scanItem.mediaKindGuess === "gif" ||
              scanItem.mediaKindGuess === "video" ||
              scanItem.mediaKindGuess === "markdown" ||
              scanItem.mediaKindGuess === "pdf" ||
              scanItem.mediaKindGuess === "pptx" ||
              scanItem.mediaKindGuess === "html" ||
              scanItem.mediaKindGuess === "html_zip"
              ? scanItem.mediaKindGuess
              : "unsupported",
            mime: scanItem.mimeGuess,
            sha256: scan.sourceKind === "upload"
              ? (sessionByPath.get(scanItem.relativePath)?.sha256 ?? null)
              : null,
            plannedSourceVersionId:
              importItem.plannedSourceVersionId ?? (() => {
                throw new ApiError({
                  statusCode: 409,
                  code: "SOURCE_CHANGED_RESCAN_REQUIRED",
                  message: "旧导入缺少来源版本预分配，请重新建立导入",
                });
              })(),
            state: importItem.state,
            ...(scanItem.metadata.pathIdentity === undefined ? {} : { pathIdentity: scanItem.metadata.pathIdentity }),
          };
        }),
      });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
      await chmod(manifestPath, 0o400);
      return JobGrantSchema.parse({ ...grant, workspacePath, manifestPath });
    }
    return JobGrantSchema.parse({ ...grant, workspacePath });
  }
  private uploadSourcePath(sessions: Map<string, UploadSessionRecord>, relativePath: string): string {
    const session = sessions.get(relativePath);
    if (session === undefined) {
      throw new ApiError({
        statusCode: 422,
        code: "SOURCE_UNREADABLE",
        message: "上传文件记录缺失",
      });
    }
    return this.blobs.resolveRelativePath(session.stagingRelativePath);
  }
}
function sha256Text(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function staleLease(): ApiError { return new ApiError({ statusCode: 409, code: "JOB_STALE_LEASE", message: "任务租约已失效" }); }
