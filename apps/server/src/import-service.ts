import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ImportCreateRequestSchema,
  ImportDetailSchema,
  type AssetMapSelection,
  type AssetMapSummary,
  type AssetMapSourceStatus,
  JobSnapshotSchema,
  ScanCreateRequestSchema,
  ScanDetailSchema,
  type ImportCreateRequest,
  type ItemResultMessage,
  type JobEvent,
  type JobGrant,
  type JobResult,
  type JobSnapshot,
  type ScanCreateRequest,
  type ScanItemResult,
  type WorkerFence,
} from "@dmall/contracts";
import { RestrictedRoot, type BlobStore } from "@dmall/storage";
import { ImportCommit } from "./import-commit.js";
import { ImportExecution } from "./import-execution.js";
import { ImportLifecycle } from "./import-lifecycle.js";
import { ApiError } from "./errors.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type { JobRepository } from "./job-repository.js";
import type { KeywordIndexService } from "./retrieval/index-service.js";
import {
  ImportRepository,
  importItemView,
  scanItemView,
  type ScanItemRecord,
  type ScanRecord,
  type UploadSessionRecord,
} from "./import-repository.js";

const SINGLE_FILE_LIMIT = 2 * 1024 * 1024 * 1024;
const BATCH_LIMIT = 10 * 1024 * 1024 * 1024;
const MAPPING_SOURCE_LIMIT = 1_048_576;
const SCAN_TTL_MS = 24 * 60 * 60 * 1000;

export interface WriteContext {
  key: string;
  scope: string;
  requestId: string;
}

export class ImportService {
  private readonly db: Database.Database;
  private readonly dataRoot: string;
  private readonly imports: ImportRepository;
  private readonly jobs: JobRepository;
  private readonly idempotency: IdempotencyRepository;
  private readonly execution: ImportExecution;
  private readonly lifecycle: ImportLifecycle;
  private readonly commit: ImportCommit;
  private readonly index: KeywordIndexService;

  constructor(input: {
    db: Database.Database;
    blobs: BlobStore;
    dataRoot: string;
    jobs: JobRepository;
    idempotency: IdempotencyRepository;
    index: KeywordIndexService;
  }) {
    this.db = input.db;
    this.dataRoot = resolve(input.dataRoot);
    this.imports = new ImportRepository(input.db);
    this.jobs = input.jobs;
    this.idempotency = input.idempotency;
    this.index = input.index;
    this.execution = new ImportExecution(this.dataRoot, this.imports, input.blobs, this.jobs);
    this.commit = new ImportCommit(
      input.db,
      input.blobs,
      this.dataRoot,
      this.imports,
      this.jobs,
      this.index,
    );
    this.lifecycle = new ImportLifecycle(this.imports, this.jobs);
    this.jobs.addLocalFinalizer((id, state, result) => this.lifecycle.finalize(id, state, result));
  }

  get repository(): ImportRepository {
    return this.imports;
  }

  async createScan(
    body: ScanCreateRequest,
    context: WriteContext,
  ): Promise<{ scanId: string; jobId: string; status: "queued" }> {
    const request = ScanCreateRequestSchema.parse(body);
    const requestHash = this.idempotency.requestHash(request);
    const existing = this.idempotency.find(context.scope, context.key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw idempotencyConflict();
      }
      return parseScanCreateResponse(existing.response);
    }

    if (request.sourceKind === "local_directory") {
      if (!isAbsolute(request.rootPath)) {
        throw new ApiError({
          statusCode: 422,
          code: "PATH_NOT_ALLOWED",
          message: "扫描根必须是绝对路径",
        });
      }
      const realRoot = await realpath(request.rootPath).catch(() => {
        throw new ApiError({
          statusCode: 422,
          code: "SOURCE_UNREADABLE",
          message: "扫描根不存在或不可读",
        });
      });
      const rootStats = await stat(realRoot);
      if (!rootStats.isDirectory()) {
        throw new ApiError({
          statusCode: 422,
          code: "SOURCE_UNREADABLE",
          message: "扫描根不是目录",
        });
      }
      const rootBoundary = await RestrictedRoot.capture(realRoot);
      const scanId = randomUUID();
      const jobId = randomUUID();
      const response = {
        scanId,
        jobId,
        status: "queued" as const,
      };
      this.db.transaction(() => {
        this.jobs.create({
          id: jobId,
          type: "local_scan",
          input: {
            schemaVersion: 1,
            jobType: "local_scan",
            scanId,
            sourceKind: "local_directory",
            rootPath: realRoot,
            rootPathIdentity: [...rootBoundary.identity],
            scannerVersion: "dcw-directory-scan/1",
          },
          inputHash: requestHash,
          idempotencyKey: context.key,
        });
        this.imports.insertScan({
          id: scanId,
          jobId,
          sourceKind: "local_directory",
          rootPath: realRoot,
          rootIdentity: sha256Text(realRoot),
          expiresAt: new Date(Date.now() + SCAN_TTL_MS).toISOString(),
        });
        this.idempotency.save({
          routeScope: context.scope,
          key: context.key,
          requestHash,
          statusCode: 202,
          requestId: context.requestId,
          response: { data: response, requestId: context.requestId },
          resultRef: jobId,
        });
      })();
      return response;
    }

    const fileIds = [...new Set(request.fileIds)];
    if (fileIds.length !== request.fileIds.length) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "上传文件 ID 不能重复",
      });
    }
    const sessions: UploadSessionRecord[] = [];
    const uploadPaths = new Set<string>();
    for (const fileId of fileIds) {
      const session = this.imports.getUploadSession(fileId);
      if (session === null || !["complete", "scan_ready"].includes(session.status)) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "上传尚未完成",
        });
      }
      if (session.declaredBytes > SINGLE_FILE_LIMIT) {
        throw new ApiError({
          statusCode: 413,
          code: "CAPACITY_EXCEEDED",
          message: "单个文件超过 2GiB",
        });
      }
      if (uploadPaths.has(session.relativePath)) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "上传集合中存在重复相对路径",
        });
      }
      uploadPaths.add(session.relativePath);
      sessions.push(session);
    }
    const totalBytes = sessions.reduce((sum, session) => sum + session.declaredBytes, 0);
    if (totalBytes > BATCH_LIMIT) {
      throw new ApiError({
        statusCode: 413,
        code: "CAPACITY_EXCEEDED",
        message: "本批次文件总量超过 10GiB",
      });
    }
    const scanId = randomUUID();
    const jobId = randomUUID();
    const uploadSetId = sha256Text([...fileIds].sort().join("\n"));
    const response = { scanId, jobId, status: "queued" as const };
    this.db.transaction(() => {
      this.jobs.create({
        id: jobId,
        type: "local_scan",
        input: {
          schemaVersion: 1,
          jobType: "local_scan",
          scanId,
          sourceKind: "upload",
          fileIds,
          scannerVersion: "dcw-directory-scan/1",
        },
        inputHash: requestHash,
        idempotencyKey: context.key,
      });
      this.imports.insertScan({
        id: scanId,
        jobId,
        sourceKind: "upload",
        rootPath: null,
        rootIdentity: uploadSetId,
        expiresAt: new Date(Date.now() + SCAN_TTL_MS).toISOString(),
      });
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 202,
        requestId: context.requestId,
        response: { data: response, requestId: context.requestId },
        resultRef: jobId,
      });
    })();
    return response;
  }

  getScanDetail(scanId: string): z.infer<typeof ScanDetailSchema> {
    const scan = this.requireScan(scanId);
    if (scan.status === "ready" && Date.parse(scan.expiresAt) <= Date.now()) {
      this.imports.setScanStatus(scanId, "expired");
      scan.status = "expired";
    }
    const displayName =
      scan.sourceKind === "upload"
        ? "本地上传"
        : basename(scan.rootPath ?? "本地目录");
    const warnings: string[] = [];
    if (scan.counts.unsupported > 0) warnings.push("部分文件格式不在本阶段支持范围");
    if (scan.counts.unreadable > 0) warnings.push("部分文件不可读，已单独列出");
    return ScanDetailSchema.parse({
      scanId: scan.id,
      jobId: scan.jobId,
      status: scan.status,
      sourceKind: scan.sourceKind,
      displayName,
      counts: scan.counts,
      exclusions: scan.exclusions,
      warnings,
      expiresAt: scan.expiresAt,
    });
  }

  listScanItems(
    scanId: string,
    options: {
      limit: number;
      offset: number;
      status?: ScanItemRecord["status"];
      kind?: ScanItemRecord["mediaKindGuess"];
    },
  ): { items: ReturnType<typeof scanItemView>[]; total: number } {
    this.requireScan(scanId);
    const result = this.imports.scanItems(scanId, options);
    return { items: result.items.map(scanItemView), total: result.total };
  }

  async createImport(
    body: ImportCreateRequest,
    context: WriteContext,
  ): Promise<{ importId: string; jobId: string; status: JobSnapshot["state"] }> {
    const request = ImportCreateRequestSchema.parse(body);
    const requestHash = this.idempotency.requestHash(request);
    const existing = this.idempotency.find(context.scope, context.key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict();
      return parseImportCreateResponse(existing.response);
    }
    const scan = this.requireScan(request.scanId);
    if (Date.parse(scan.expiresAt) <= Date.now()) {
      if (scan.status === "ready") this.imports.setScanStatus(scan.id, "expired");
      throw new ApiError({
        statusCode: 409,
        code: "SOURCE_CHANGED_RESCAN_REQUIRED",
        message: "扫描已过期，请重新扫描",
      });
    }
    const selectionHash = this.idempotency.requestHash({
      scanId: request.scanId,
      selection: request.selection,
      assetMap: request.assetMap ?? null,
    });
    const legacySelectionHash = this.idempotency.requestHash({
      scanId: request.scanId,
      selection: request.selection,
    });
    if (scan.status === "consumed") {
      const sameSelection =
        scan.selectionHash === selectionHash ||
        (request.assetMap === undefined && scan.selectionHash === legacySelectionHash);
      if (sameSelection && scan.importJobId !== null) {
        const snapshot = this.jobs.snapshotById(scan.importJobId);
        return { importId: snapshot.id, jobId: snapshot.id, status: snapshot.state };
      }
      throw new ApiError({
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "该扫描已用不同选择确认导入，请重新扫描",
      });
    }
    if (scan.status !== "ready") {
      throw new ApiError({
        statusCode: 409,
        code: "JOB_NOT_RESUMABLE",
        message: "扫描尚未完成，不能确认导入",
      });
    }
    const candidateItems = this.imports.candidateScanItems(scan.id);
    const candidateById = new Map(candidateItems.map((item) => [item.id, item]));
    const include = new Set(request.selection.includeItemIds);
    const exclude = new Set(request.selection.excludeItemIds);
    if (request.selection.mode === "all" && include.size > 0) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "全部选择模式下不能同时提交显式项目",
      });
    }
    if (request.selection.mode === "explicit" && include.size === 0) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "显式选择为空，不会自动改为全选",
      });
    }
    for (const id of include) {
      if (!candidateById.has(id)) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "选择项不属于该扫描的可导入项目",
          details: { itemId: id },
        });
      }
    }
    for (const id of exclude) {
      if (!candidateById.has(id)) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "排除项不属于该扫描的可导入项目",
          details: { itemId: id },
        });
      }
    }
    const selected =
      request.selection.mode === "all"
        ? candidateItems.filter((item) => !exclude.has(item.id))
        : candidateItems.filter((item) => include.has(item.id) && !exclude.has(item.id));
    if (selected.length === 0) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "没有选中任何可导入项目",
      });
    }
    const selectedIds = new Set(selected.map((item) => item.id));
    for (const mappingId of request.assetMap?.sourceScanItemIds ?? []) {
      const mappingItem = candidateById.get(mappingId);
      if (mappingItem === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "映射来源项不属于该扫描的可导入项目",
          details: { itemId: mappingId },
        });
      }
      if (!selectedIds.has(mappingId)) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "映射来源项不在最终选择中",
          details: { itemId: mappingId },
        });
      }
      if (mappingItem.mediaKindGuess !== "markdown") {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "映射来源项必须是 Markdown",
          details: { itemId: mappingId },
        });
      }
      if (mappingItem.bytes > MAPPING_SOURCE_LIMIT) {
        throw new ApiError({
          statusCode: 422,
          code: "MAPPING_TOO_LARGE",
          message: "映射文档超过 1MiB",
          details: { itemId: mappingId, bytes: mappingItem.bytes },
        });
      }
    }
    const totalBytes = selected.reduce((sum, item) => sum + item.bytes, 0);
    if (totalBytes > BATCH_LIMIT) {
      throw new ApiError({
        statusCode: 413,
        code: "CAPACITY_EXCEEDED",
        message: "本批次文件总量超过 10GiB",
      });
    }
    const importId = randomUUID();
    const response = { importId, jobId: importId, status: "queued" as const };
    this.db.transaction(() => {
      this.jobs.create({
        id: importId,
        type: "local_import",
        input: {
          schemaVersion: 1,
          jobType: "local_import",
          importId,
          scanId: scan.id,
          selectedItemIds: selected.map((item) => item.id),
          excludedItemIds: [...exclude],
          ...(request.assetMap === undefined ? {} : { assetMap: request.assetMap }),
          options: request.options,
          processorVersions: {
            pipeline: "dcw-local-import/1",
            magicSniffer: "dcw-magic/1",
            markdownParser: "dcw-markdown/1",
            sharp: "sharp/0.35.5",
            ffprobe: "ffprobe/8.1",
          },
        },
        inputHash: requestHash,
        idempotencyKey: context.key,
      });
      this.imports.createImportItems(importId, selected);
      this.imports.consumeScan(scan.id, selectionHash, importId);
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 202,
        requestId: context.requestId,
        response: { data: response, requestId: context.requestId },
        resultRef: importId,
      });
    })();
    return { importId, jobId: importId, status: "queued" };
  }

  getImportDetail(
    importId: string,
    options: { limit: number; offset: number },
  ): z.infer<typeof ImportDetailSchema> {
    const snapshot = this.jobs.snapshotById(importId);
    if (snapshot.type !== "local_import") {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "导入不存在" });
    }
    const input = this.jobs.get(importId)?.input;
    if (input === undefined || input.jobType !== "local_import") {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "导入不存在" });
    }
    const page = this.imports.importItems(importId, options);
    const items = page.items.map((item) => {
      const scanItem = this.imports.requireScanItem(item.scanItemId);
      return importItemView(item, scanItem);
    });
    const counts = this.imports.importCounts(importId);
    const result =
      snapshot.result !== null && snapshot.result.jobType === "local_import"
        ? {
            jobType: snapshot.result.jobType,
            importId: snapshot.result.importId,
            committed: snapshot.result.committed,
            skipped: snapshot.result.skipped,
            failed: snapshot.result.failed,
            assetIds: snapshot.result.assetIds,
          }
        : null;
    return ImportDetailSchema.parse({
      importId,
      jobId: importId,
      scanId: input.scanId,
      status: snapshot.state,
      phase: snapshot.phase,
      counts,
      items,
      nextCursor:
        options.offset + items.length < page.total ? String(options.offset + options.limit) : null,
      result,
      mapping: this.mappingSummary(importId, input.assetMap, snapshot.state),
      error: snapshot.error,
    });
  }

  retryImport(
    importId: string,
    itemIds: readonly string[],
    context: WriteContext,
  ): JobSnapshot {
    const requestHash = this.idempotency.requestHash({ importId, itemIds });
    const existing = this.idempotency.find(context.scope, context.key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict();
      return z
        .strictObject({ data: JobSnapshotSchema, requestId: z.string() })
        .parse(existing.response).data;
    }
    const snapshot = this.jobs.snapshotById(importId);
    if (snapshot.type !== "local_import" || snapshot.state === "running") {
      throw new ApiError({
        statusCode: 409,
        code: "JOB_NOT_RESUMABLE",
        message: "导入当前不能重试",
      });
    }
    const changed = this.db.transaction(() => {
      const count = this.imports.resetImportItemsForRetry(importId, itemIds);
      if (count === 0) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "所选项目没有可重试的失败项",
        });
      }
      const next = this.jobs.prepareRetry(importId);
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 202,
        requestId: context.requestId,
        response: { data: next, requestId: context.requestId },
        resultRef: importId,
      });
      return next;
    })();
    return changed;
  }

  async acceptItemResult(message: ItemResultMessage): Promise<JobEvent | null> {
    if (!this.jobs.isFenceValid(message.fence)) {
      throw staleLease();
    }
    if (message.kind === "scan_item") return this.acceptScanItem(message.fence, message.item);
    if (message.kind === "document_media_batch") {
      await this.commit.acceptDocumentMediaBatch(message.fence, message.batch);
      return null;
    }
    return await this.commit.accept(message.fence, message.item, message.stagedFiles);
  }

  async prepareGrant(grant: JobGrant): Promise<JobGrant> {
    return this.execution.prepareGrant(grant);
  }

  finalizeJob(fence: WorkerFence, state: "succeeded" | "partial" | "failed" | "cancelled"): JobResult | null {
    return this.lifecycle.finalize(fence.jobId, state, null).result;
  }

  scanForJob(jobId: string): ScanRecord {
    const row = z
      .strictObject({ id: z.uuid() })
      .parse(this.db.prepare("SELECT id FROM import_scans WHERE job_id = ?").get(jobId));
    return this.requireScan(row.id);
  }

  private acceptScanItem(fence: WorkerFence, item: ScanItemResult): JobEvent {
    return this.db.transaction(() => {
      if (!this.jobs.isFenceValid(fence)) throw staleLease();
      const row = this.jobs.get(fence.jobId);
      if (row === null || row.input.jobType !== "local_scan") throw staleLease();
      const stored = this.imports.upsertScanItem(row.input.scanId, item);
      return this.jobs.appendEventInTransaction({
        jobId: fence.jobId,
        kind: "item_result",
        phase: "scanning",
        done: null,
        total: null,
        payload: {
          kind: "item_result",
          itemId: stored.id,
          state: item.status,
          message:
            item.status === "candidate"
              ? `发现 ${item.relativePath}`
              : `跳过 ${item.relativePath}`,
        },
      });
    })();
  }

  private requireScan(scanId: string): ScanRecord {
    const scan = this.imports.getScan(scanId);
    if (scan === null) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "扫描不存在" });
    }
    return scan;
  }

  private mappingSummary(
    importId: string,
    assetMap: AssetMapSelection | undefined,
    jobState: JobSnapshot["state"],
  ): AssetMapSummary | null {
    if (assetMap === undefined) return null;
    const terminal = jobState !== "queued" && jobState !== "running" && jobState !== "waiting_input";
    const countsBySource = this.imports.mappingEntryCountsBySource(importId);
    const linkedAssetCount = this.imports.mappingLinkedAssetCount(importId);
    const sources: AssetMapSourceStatus[] = assetMap.sourceScanItemIds.map((sourceScanItemId, mapIndex) => {
      const scanItem = this.imports.requireScanItem(sourceScanItemId);
      const item = this.imports.importItemByScanItem(importId, sourceScanItemId);
      const mapping = item?.result.mapping;
      const counts =
        item?.sourceVersionId === null || item?.sourceVersionId === undefined
          ? { entryCount: 0, linkedEntryCount: 0 }
          : (countsBySource.get(item.sourceVersionId) ?? { entryCount: 0, linkedEntryCount: 0 });
      let status: AssetMapSourceStatus["status"];
      let errorCode: string | null = null;
      if (item === null) {
        status = terminal ? "failed" : "pending";
        errorCode = terminal ? "MAPPING_ITEM_MISSING" : null;
      } else if (item.state === "committed") {
        if (mapping?.status === "applied") {
          status = "applied";
        } else if (mapping?.status === "failed") {
          status = "failed";
          errorCode = mapping.errorCode;
        } else {
          status = terminal ? "failed" : "pending";
          errorCode = terminal ? "MAPPING_NOT_APPLIED" : null;
        }
      } else if (item.state === "failed") {
        status = "failed";
        errorCode = item.error?.code ?? "MAPPING_ITEM_FAILED";
      } else if (item.state === "skipped") {
        status = "skipped";
        errorCode = item.error?.code ?? "JOB_CANCELLED";
      } else {
        status = terminal ? (jobState === "cancelled" ? "skipped" : "failed") : "pending";
        errorCode = terminal ? (jobState === "cancelled" ? "JOB_CANCELLED" : "MAPPING_NOT_APPLIED") : null;
      }
      return {
        sourceScanItemId,
        relativePath: scanItem.relativePath,
        mapIndex,
        status,
        sourceVersionId: item?.sourceVersionId ?? null,
        entryCount: mapping?.entryCount ?? counts.entryCount,
        linkedEntryCount: counts.linkedEntryCount,
        warningCount: mapping?.warningCount ?? 0,
        errorCode,
      };
    });
    const appliedSourceCount = sources.filter((source) => source.status === "applied").length;
    const failed = sources.some((source) => source.status === "failed");
    const skipped = sources.some((source) => source.status === "skipped");
    const pending = sources.some((source) => source.status === "pending");
    const status: AssetMapSummary["status"] = pending
      ? "pending"
      : skipped && appliedSourceCount === 0 && !failed
        ? "skipped"
        : appliedSourceCount === sources.length
          ? "applied"
          : appliedSourceCount > 0
            ? "partial"
            : "failed";
    return {
      requestedSourceCount: sources.length,
      appliedSourceCount,
      status,
      entryCount: sources.reduce((sum, source) => sum + source.entryCount, 0),
      linkedEntryCount: linkedAssetCount,
      warningCount: sources.reduce((sum, source) => sum + source.warningCount, 0),
      sources,
    };
  }
}

function parseScanCreateResponse(response: unknown): { scanId: string; jobId: string; status: "queued" } {
  return z
    .strictObject({
      data: z.strictObject({
        scanId: z.uuid(),
        jobId: z.uuid(),
        status: z.literal("queued"),
      }),
      requestId: z.string(),
    })
    .parse(response).data;
}

function parseImportCreateResponse(response: unknown): {
  importId: string;
  jobId: string;
  status: JobSnapshot["state"];
} {
  return z
    .strictObject({
      data: z.strictObject({
        importId: z.uuid(),
        jobId: z.uuid(),
        status: z.enum(["queued", "running", "waiting_input", "succeeded", "partial", "failed", "cancelled"]),
      }),
      requestId: z.string(),
    })
    .parse(response).data;
}

function idempotencyConflict(): ApiError {
  return new ApiError({
    statusCode: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "同一 Idempotency-Key 对应了不同请求",
  });
}

function staleLease(): ApiError {
  return new ApiError({
    statusCode: 409,
    code: "JOB_STALE_LEASE",
    message: "任务租约已失效，结果被拒绝",
  });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
