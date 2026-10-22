import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  type AssetMapSelectedItem,
  type AssetMapParseResult,
  parseAssetMapDocument,
} from "@dmall/domain";
import type {
  AssetMapCommitResult,
  DocumentExtractionDraft,
  ImportItemResult,
  StagedDocumentMedia,
  StagedFile,
  WorkerFence,
  JobEvent,
  OccurrenceLocator,
} from "@dmall/contracts";
import { locatorKey } from "@dmall/contracts";
import type { BlobStore } from "@dmall/storage";
import type { ImportRepository, ScanRecord, ScanItemRecord, ImportItemRecord } from "./import-repository.js";
import type { JobRepository } from "./job-repository.js";
import { ApiError } from "./errors.js";
import type { KeywordIndexService } from "./retrieval/index-service.js";
export class ImportCommit {
  private static readonly MAPPING_BYTES_LIMIT = 1_048_576;

  constructor(
    private readonly db: Database.Database,
    private readonly blobs: BlobStore,
    private readonly dataRoot: string,
    private readonly imports: ImportRepository,
    private readonly jobs: JobRepository,
    private readonly index: KeywordIndexService,
  ) { }
  async acceptDocumentMediaBatch(
    fence: WorkerFence,
    batch: {
      scanItemId: string;
      batchIndex: number;
      batchCount: number;
      media: readonly StagedDocumentMedia[];
    },
  ): Promise<null> {
    const existing = this.imports.importItemByScanItem(fence.jobId, batch.scanItemId);
    if (existing === null) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "媒体批次不属于当前导入任务",
      });
    }
    if (existing.state === "committed") return null;
    const workspace = this.workspaceFor(fence);
    const verified: StagedDocumentMedia[] = [];
    for (const media of batch.media) {
      const absolute = resolve(workspace, media.relativePath);
      const rel = relative(workspace, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new ApiError({
          statusCode: 422,
          code: "PATH_NOT_ALLOWED",
          message: "文档媒体暂存路径越出任务工作目录",
        });
      }
      const stats = await stat(absolute).catch(() => null);
      if (stats === null || !stats.isFile() || stats.size !== media.bytes) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: `文档媒体字节数不匹配：${media.adapterId}`,
        });
      }
      const stored = await this.blobs.putFile({
        path: absolute,
        mime: media.mime,
        expectedSha256: media.sha256,
      });
      if (stored.sha256 !== media.sha256 || stored.bytes !== media.bytes) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: `文档媒体 hash 校验失败：${media.adapterId}`,
        });
      }
      verified.push(media);
    }
    this.db.transaction(() => {
      if (!this.jobs.isFenceValid(fence)) throw staleLease();
      this.imports.upsertStagedDocumentMedia({
        jobId: fence.jobId,
        scanItemId: batch.scanItemId,
        batchIndex: batch.batchIndex,
        batchCount: batch.batchCount,
        media: verified,
      });
    })();
    return null;
  }

  async accept(fence: WorkerFence, item: ImportItemResult, stagedFiles: StagedFile[]): Promise<JobEvent | null> {
    const existing = this.imports.importItemByScanItem(fence.jobId, item.scanItemId);
    if (existing === null) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "项目不属于当前导入任务",
      });
    }
    if (existing.state === "committed")
      return null;
    if (item.state === "failed") {
      return this.db.transaction(() => {
        if (!this.jobs.isFenceValid(fence))
          throw staleLease();
        this.imports.setImportItemState({
          id: existing.id,
          state: "failed",
          error: { code: item.errorCode, message: item.message, retryable: item.retryable },
        });
        return this.importsEvent(fence, existing, "failed", item.message);
      })();
    }
    const scanItem = this.imports.requireScanItem(item.scanItemId);
    const row = this.jobs.get(fence.jobId);
    if (row === null || row.input.jobType !== "local_import")
      throw staleLease();
    const scan = this.imports.requireScan(row.input.scanId);
    const workspace = this.workspaceFor(fence);
    const prepared = await this.prepareStagedFiles(item, stagedFiles, workspace);
    const mappingIndex = row.input.assetMap?.sourceScanItemIds.indexOf(scanItem.id) ?? -1;
    const documentItem = item.kind === "document" ? item.document : undefined;
    if (item.kind === "document" && documentItem === undefined) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "文档结果缺少抽取结构",
      });
    }
    const mappingRequested =
      mappingIndex >= 0 &&
      (item.kind === "markdown" ||
        (item.kind === "document" && documentItem?.format === "markdown"));
    let mappingParse: AssetMapParseResult | null = null;
    if (mappingRequested) {
      const original = prepared.find((file) => file.role === "original");
      if (original === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "映射原件缺失",
        });
      }
      try {
        const bytes = await readFile(this.blobs.pathForHash(original.sha256));
        if (bytes.byteLength > ImportCommit.MAPPING_BYTES_LIMIT) {
          mappingParse = {
            ok: false,
            errorCode: "MAPPING_READ_FAILED",
            warnings: [],
            warningCount: 0,
          };
        } else {
          const selectedItems = this.imports.selectedScanItems(fence.jobId).map(toAssetMapSelectedItem);
          mappingParse = parseAssetMapDocument({
            mapIndex: mappingIndex,
            mapping: {
              scanItemId: scanItem.id,
              relativePath: scanItem.relativePath,
              kind: "markdown",
              bytes: scanItem.bytes,
            },
            snapshotBytes: bytes,
            selectedItems,
          });
        }
      } catch {
        mappingParse = {
          ok: false,
          errorCode: "MAPPING_READ_FAILED",
          warnings: [],
          warningCount: 0,
        };
      }
    }
    return this.db.transaction(() => {
      if (!this.jobs.isFenceValid(fence))
        throw staleLease();
      const currentRow = this.jobs.get(fence.jobId);
      if (currentRow === null || currentRow.snapshot.cancelRequested)
        throw staleLease();
      const blobHashes = new Map<string, string>();
      for (const file of prepared) {
        this.db
          .prepare(`INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`)
          .run(file.sha256, file.relativePath, file.mime, file.bytes, new Date().toISOString());
        blobHashes.set(file.role, file.sha256);
      }
      const originalHash = blobHashes.get("original");
      if (originalHash === undefined || originalHash !== item.sha256) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "原件 hash 与结果不一致",
        });
      }
      const now = new Date().toISOString();
      const source = this.upsertSource(scan, scanItem, item, now);
      if (existing.plannedSourceVersionId === null) {
        throw new ApiError({
          statusCode: 409,
          code: "SOURCE_CHANGED_RESCAN_REQUIRED",
          message: "导入项缺少预分配的来源版本",
        });
      }
      const sourceVersionId = this.upsertSourceVersion(
        source.id,
        item,
        originalHash,
        existing.plannedSourceVersionId,
        now,
      );
      let assetId: string | null = null;
      let occurrenceId: string | null = null;
      if (item.kind === "document") {
        const committed = this.commitDocument({
          fence,
          item,
          sourceVersionId,
          now,
        });
        assetId = committed.firstAssetId;
        occurrenceId = committed.firstOccurrenceId;
      } else if (item.kind !== "markdown") {
        assetId = this.upsertAsset(originalHash, item.kind, now);
        this.ensureInitialAssetVersion(assetId, item, scanItem, now);
        this.ensureDerivatives(assetId, originalHash, prepared, item, now);
        this.attachMarkdownOccurrences(fence.jobId, scanItem.relativePath, assetId, now);
        this.imports.linkAssetMapEntries({
          importJobId: fence.jobId,
          normalizedRelativePath: scanItem.relativePath,
          assetId,
          now,
        });
        occurrenceId = this.upsertOccurrence({
          sourceVersionId,
          assetId,
          locator: {
            schemaVersion: 1,
            kind: "local_file",
            relativePath: scanItem.relativePath,
          },
          occurrenceIndex: 0,
          headingPath: "",
          beforeText: "",
          afterText: "",
          mediaStatus: "available",
          errorCode: null,
          now,
        });
      }
      else {
        for (const draft of item.markdownOccurrences) {
          const mappedAsset = draft.resolvedRelativePath === null
            ? null
            : this.imports.committedAssetForPath(fence.jobId, draft.resolvedRelativePath);
          const available = mappedAsset !== null;
          const status = available
            ? "available"
            : draft.mediaStatus === "unsupported"
              ? "unsupported"
              : "missing";
          const id = this.upsertOccurrence({
            sourceVersionId,
            assetId: mappedAsset,
            locator: draft.locator,
            occurrenceIndex: draft.locator.ordinal,
            headingPath: draft.headingPath,
            beforeText: draft.beforeText,
            afterText: draft.afterText,
            mediaStatus: status,
            errorCode: available ? null : (draft.errorCode ?? "MISSING_DEPENDENCY"),
            now,
          });
          occurrenceId ??= id;
        }
      }
      let mappingResult: AssetMapCommitResult | undefined;
      if (mappingRequested && mappingParse !== null) {
        mappingResult = {
          status: mappingParse.ok ? "applied" : "failed",
          parserVersion: "dcw-asset-map/1",
          errorCode: mappingParse.ok ? null : mappingParse.errorCode,
          sourceVersionId,
          entryCount: mappingParse.ok ? mappingParse.entries.length : 0,
          warningCount: mappingParse.warningCount,
          warnings: [...mappingParse.warnings],
        };
        if (mappingParse.ok) {
          this.imports.upsertAssetMapEntries({
            importJobId: fence.jobId,
            scanId: scan.id,
            mappingScanItemId: scanItem.id,
            mappingSourceVersionId: sourceVersionId,
            mapIndex: mappingIndex,
            entries: mappingParse.entries,
            now,
          });
          this.imports.backfillAssetMapEntries({
            importJobId: fence.jobId,
            mappingSourceVersionId: sourceVersionId,
            now,
          });
        }
      }
      this.imports.setImportItemState({
        id: existing.id,
        state: "committed",
        sourceId: source.id,
        sourceVersionId,
        assetId,
        occurrenceId,
        result: {
          kind: item.kind,
          sha256: item.sha256,
          bytes: item.bytes,
          mime: item.mime,
          ...(item.kind === "document" && item.document !== undefined
            ? {
                documentStatus: item.document.status,
                documentFormat: item.document.format,
              }
            : {}),
          ...(mappingResult === undefined ? {} : { mapping: mappingResult }),
        },
      });
      this.index.rebuild();
      return this.importsEvent(fence, existing, "committed", `${scanItem.relativePath} 已提交`);
    })();
  }
  private importsEvent(fence: WorkerFence, item: ImportItemRecord, state: string, message: string): JobEvent {
    return this.jobs.appendEventInTransaction({
      jobId: fence.jobId,
      kind: "item_result",
      phase: "importing",
      done: null,
      total: null,
      payload: {
        kind: "item_result",
        itemId: item.id,
        state,
        message,
      },
    });
  }

  private commitDocument(input: {
    fence: WorkerFence;
    item: Extract<ImportItemResult, { state: "committed" }>;
    sourceVersionId: string;
    now: string;
  }): { firstAssetId: string | null; firstOccurrenceId: string | null } {
    const document = input.item.document;
    if (document === undefined) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "文档缺少结构化抽取结果",
      });
    }
    const media = this.imports.stagedDocumentMedia(
      input.fence.jobId,
      input.item.scanItemId,
    );
    if (media.length !== document.mediaCount) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: `文档媒体批次不完整：期望 ${document.mediaCount}，收到 ${media.length}`,
      });
    }
    this.db
      .prepare(
        `INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
      )
      .run(
        input.item.sha256,
        this.blobs.relativePathForHash(input.item.sha256),
        input.item.mime,
        input.item.bytes,
        input.now,
      );
    const mediaAssetByAdapter = new Map<string, string>();
    for (const resource of media) {
      this.db
        .prepare(
          `INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
        )
        .run(
          resource.sha256,
          this.blobs.relativePathForHash(resource.sha256),
          resource.mime,
          resource.bytes,
          input.now,
        );
      const assetId = this.upsertAsset(resource.sha256, resource.mediaKind, input.now);
      this.ensureDocumentAssetVersion({
        assetId,
        media: resource,
        processorVersion: document.processorVersion,
        now: input.now,
      });
      mediaAssetByAdapter.set(resource.adapterId, assetId);
      this.persistAdapterId({
        sourceVersionId: input.sourceVersionId,
        processorInternalId: resource.adapterId,
        entityType: "media",
        businessId: assetId,
        now: input.now,
      });
    }

    const sectionIdByAdapter = new Map<string, string>();
    const blockIdByAdapter = new Map<string, string>();
    const blockLocatorById = new Map<string, import("@dmall/contracts").Locator>();
    const sectionLocatorById = new Map<string, import("@dmall/contracts").Locator>();
    for (const section of document.sections) {
      const sectionId = this.resolveSection({
        sourceVersionId: input.sourceVersionId,
        section,
        now: input.now,
      });
      sectionIdByAdapter.set(section.adapterId, sectionId);
      sectionLocatorById.set(section.adapterId, section.locator);
      for (const block of section.blocks) {
        const blockId = this.resolveBlock({
          sourceVersionId: input.sourceVersionId,
          sectionId,
          block,
          now: input.now,
        });
        blockIdByAdapter.set(block.adapterId, blockId);
        blockLocatorById.set(block.adapterId, block.locator);
      }
    }

    let firstAssetId: string | null = null;
    let firstOccurrenceId: string | null = null;
    for (const [ordinal, occurrence] of document.occurrences.entries()) {
      const sectionId = sectionIdByAdapter.get(occurrence.sectionAdapterId);
      if (sectionId === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: `媒体位置引用未知章节 ${occurrence.sectionAdapterId}`,
        });
      }
      const mediaAsset =
        occurrence.mediaAdapterId === null
          ? null
          : mediaAssetByAdapter.get(occurrence.mediaAdapterId) ??
            this.imports.committedAssetForPath(
              input.fence.jobId,
              occurrence.mediaAdapterId,
            );
      const status = mediaAsset !== null
        ? "available"
        : occurrence.mediaStatus === "unsupported"
          ? "unsupported"
          : "missing";
      const occurrenceId = this.upsertOccurrence({
        sourceVersionId: input.sourceVersionId,
        assetId: mediaAsset,
        sectionId,
        locator: occurrence.locator,
        positionKey: JSON.stringify([
          "document",
          sectionId,
          locatorKey(occurrence.locator),
          occurrence.adapterId,
        ]),
        occurrenceIndex: ordinal,
        headingPath: occurrence.headingPath,
        beforeText: occurrence.beforeText,
        afterText: occurrence.afterText,
        mediaStatus: status,
        errorCode: mediaAsset !== null ? null : occurrence.errorCode,
        now: input.now,
      });
      this.persistAdapterId({
        sourceVersionId: input.sourceVersionId,
        processorInternalId: occurrence.adapterId,
        entityType: "occurrence",
        businessId: occurrenceId,
        now: input.now,
      });
      firstAssetId ??= mediaAsset;
      firstOccurrenceId ??= occurrenceId;
    }

    this.index.insertDocumentChunks({
      sourceVersionId: input.sourceVersionId,
      drafts: document.chunkDrafts,
      sectionIdByAdapter,
      blockIdByAdapter,
      blockLocatorById,
      sectionLocatorById,
      now: input.now,
    });
    return { firstAssetId, firstOccurrenceId };
  }

  private resolveSection(input: {
    sourceVersionId: string;
    section: DocumentExtractionDraft["sections"][number];
    now: string;
  }): string {
    const mapped = this.adapterBusinessId(
      input.sourceVersionId,
      input.section.adapterId,
      "section",
    );
    if (mapped !== null) return mapped;
    const existing = this.db
      .prepare(
        "SELECT id FROM document_sections WHERE source_version_id = ? AND adapter_id = ?",
      )
      .get(input.sourceVersionId, input.section.adapterId);
    if (existing !== undefined) {
      const id = z.strictObject({ id: z.uuid() }).parse(existing).id;
      this.persistAdapterId({
        sourceVersionId: input.sourceVersionId,
        processorInternalId: input.section.adapterId,
        entityType: "section",
        businessId: id,
        now: input.now,
      });
      return id;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO document_sections(
          id, source_version_id, adapter_id, ordinal, title, heading_path, text,
          locator_json, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceVersionId,
        input.section.adapterId,
        input.section.ordinal,
        input.section.title,
        input.section.headingPath,
        input.section.text,
        JSON.stringify(input.section.locator),
        input.section.notes,
        input.now,
      );
    this.persistAdapterId({
      sourceVersionId: input.sourceVersionId,
      processorInternalId: input.section.adapterId,
      entityType: "section",
      businessId: id,
      now: input.now,
    });
    return id;
  }

  private resolveBlock(input: {
    sourceVersionId: string;
    sectionId: string;
    block: DocumentExtractionDraft["sections"][number]["blocks"][number];
    now: string;
  }): string {
    const mapped = this.adapterBusinessId(
      input.sourceVersionId,
      input.block.adapterId,
      "block",
    );
    if (mapped !== null) return mapped;
    const existing = this.db
      .prepare(
        "SELECT id FROM document_blocks WHERE source_version_id = ? AND adapter_id = ?",
      )
      .get(input.sourceVersionId, input.block.adapterId);
    if (existing !== undefined) {
      const id = z.strictObject({ id: z.uuid() }).parse(existing).id;
      this.persistAdapterId({
        sourceVersionId: input.sourceVersionId,
        processorInternalId: input.block.adapterId,
        entityType: "block",
        businessId: id,
        now: input.now,
      });
      return id;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO document_blocks(
          id, source_version_id, section_id, adapter_id, ordinal, text,
          locator_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceVersionId,
        input.sectionId,
        input.block.adapterId,
        input.block.ordinal,
        input.block.text,
        JSON.stringify(input.block.locator),
        input.now,
      );
    this.persistAdapterId({
      sourceVersionId: input.sourceVersionId,
      processorInternalId: input.block.adapterId,
      entityType: "block",
      businessId: id,
      now: input.now,
    });
    return id;
  }

  private adapterBusinessId(
    sourceVersionId: string,
    processorInternalId: string,
    entityType: "section" | "block" | "media" | "occurrence",
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT business_id FROM adapter_local_ids
         WHERE source_version_id = ? AND processor_internal_id = ? AND entity_type = ?`,
      )
      .get(sourceVersionId, processorInternalId, entityType);
    return row === undefined
      ? null
      : z.strictObject({ business_id: z.uuid() }).parse(row).business_id;
  }

  private persistAdapterId(input: {
    sourceVersionId: string;
    processorInternalId: string;
    entityType: "section" | "block" | "media" | "occurrence";
    businessId: string;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO adapter_local_ids(
          source_version_id, processor_internal_id, entity_type, business_id, created_at
        ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        input.sourceVersionId,
        input.processorInternalId,
        input.entityType,
        input.businessId,
        input.now,
      );
  }

  private ensureDocumentAssetVersion(input: {
    assetId: string;
    media: StagedDocumentMedia;
    processorVersion: string;
    now: string;
  }): void {
    const count = z
      .strictObject({ count: z.int().nonnegative() })
      .parse(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM asset_versions WHERE asset_id = ?")
          .get(input.assetId),
      ).count;
    if (count > 0) return;
    const fileName = input.media.sourceInternalPath.split("/").at(-1) ?? "文档媒体";
    const title = [...fileName].slice(0, 200).join("");
    this.db
      .prepare(
        `INSERT INTO asset_versions(
          id, asset_id, title, metadata_json, human_fields_json, version, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        randomUUID(),
        input.assetId,
        title === "" ? "文档媒体" : title,
        JSON.stringify({
          magicMime: input.media.mime,
          extensionMismatch: false,
          processorVersions: { document: input.processorVersion },
          probe: null,
        }),
        JSON.stringify({
          title: title === "" ? "文档媒体" : title,
          tags: [],
          origins: { title: "source", tags: "source" },
          merchant: null,
        }),
        input.now,
      );
  }

  private async prepareStagedFiles(item: Extract<ImportItemResult, {
    state: "committed";
  }>, files: readonly StagedFile[], workspace: string): Promise<PreparedFile[]> {
    const required = requiredRoles(item.kind);
    const byRole = new Map(files.map((file) => [file.role, file]));
    const prepared: PreparedFile[] = [];
    for (const role of required) {
      const file = byRole.get(role);
      if (file === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: `缺少 ${role} 暂存文件`,
        });
      }
      const absolute = resolve(workspace, file.relativePath);
      const rel = relative(workspace, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new ApiError({
          statusCode: 422,
          code: "PATH_NOT_ALLOWED",
          message: "暂存文件越出任务工作目录",
        });
      }
      const expectedMime = role === "original" ? item.mime : role === "poster" ? "image/webp" : "video/mp4";
      if (file.mime !== expectedMime) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: `暂存文件 MIME 不匹配：${role}`,
        });
      }
      prepared.push({ ...file, role, absolute, mime: expectedMime });
    }
    const verified: PreparedFile[] = [];
    for (const file of prepared) {
      const stats = await stat(file.absolute);
      if (!stats.isFile() || stats.size !== file.bytes) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "暂存文件字节数不匹配",
        });
      }
      const stored = await this.blobs.putFile({
        path: file.absolute,
        expectedSha256: file.sha256,
        mime: file.mime,
      });
      if (stored.sha256 !== file.sha256 || stored.bytes !== file.bytes) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "暂存文件 hash 校验失败",
        });
      }
      verified.push({
        role: file.role,
        absolute: file.absolute,
        sha256: stored.sha256,
        relativePath: stored.relativePath,
        bytes: stored.bytes,
        mime: file.mime,
      });
    }
    return verified;
  }
  private upsertSource(scan: ScanRecord, scanItem: ScanItemRecord, item: Extract<ImportItemResult, {
    state: "committed";
  }>, now: string): {
    id: string;
  } {
    const canonicalKey = scan.sourceKind === "local_directory"
      ? `local-dir:${scan.rootIdentity ?? sha256Text(scan.rootPath ?? "")}:${scanItem.relativePath}`
      : `local-upload:${scan.rootIdentity ?? sha256Text(item.sha256)}:${scanItem.relativePath}`;
    const originalUri = scan.sourceKind === "local_directory" && scan.rootPath !== null
      ? resolve(scan.rootPath, ...scanItem.relativePath.split("/"))
      : null;
    const sourceKind =
      item.kind === "document" && item.document !== undefined
        ? documentSourceKind(item.document.format)
        : item.kind === "markdown"
          ? "local_markdown"
          : "local_file";
    const title =
      item.kind === "document" && item.document !== undefined
        ? item.document.title
        : item.title;
    this.db
      .prepare(`INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(canonical_key) DO UPDATE SET title = sources.title, updated_at = sources.updated_at`)
      .run(randomUUID(), sourceKind, canonicalKey, title, originalUri, now, now);
    return z
      .strictObject({ id: z.uuid() })
      .parse(this.db.prepare("SELECT id FROM sources WHERE canonical_key = ?").get(canonicalKey));
  }
  private upsertSourceVersion(
    sourceId: string,
    item: Extract<ImportItemResult, { state: "committed" }>,
    blobHash: string,
    plannedSourceVersionId: string,
    now: string,
  ): string {
    const processorVersion =
      item.kind === "document" && item.document !== undefined
        ? item.document.processorVersion
        : "dcw-local-import/1";
    const extractionSnapshot =
      item.kind === "document" && item.document !== undefined
        ? JSON.stringify(item.document.extractionSnapshot)
        : null;
    this.db
      .prepare(`INSERT INTO source_versions(
        id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at,
        created_at, processor_version, extraction_snapshot_json, source_relative_path
      )
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, fingerprint) DO NOTHING`)
      .run(
        plannedSourceVersionId,
        sourceId,
        item.sha256,
        blobHash,
        now,
        now,
        processorVersion,
        extractionSnapshot,
        this.imports.requireScanItem(item.scanItemId).relativePath,
      );
    return z
      .strictObject({ id: z.uuid() })
      .parse(this.db
      .prepare("SELECT id FROM source_versions WHERE source_id = ? AND fingerprint = ?")
      .get(sourceId, item.sha256)).id;
  }
  private upsertAsset(blobHash: string, kind: string, now: string): string {
    this.db
      .prepare(`INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(blob_hash) DO NOTHING`)
      .run(randomUUID(), blobHash, kind, now, now);
    return z
      .strictObject({ id: z.uuid() })
      .parse(this.db.prepare("SELECT id FROM assets WHERE blob_hash = ?").get(blobHash)).id;
  }
  private ensureInitialAssetVersion(assetId: string, item: Extract<ImportItemResult, {
    state: "committed";
  }>, scanItem: ScanItemRecord, now: string): void {
    const existing = z
      .strictObject({ count: z.int().nonnegative() })
      .parse(this.db.prepare("SELECT COUNT(*) AS count FROM asset_versions WHERE asset_id = ?").get(assetId)).count;
    if (existing > 0)
      return;
    this.db
      .prepare(`INSERT INTO asset_versions
     (id, asset_id, title, metadata_json, human_fields_json, version, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`)
      .run(randomUUID(), assetId, item.title, JSON.stringify({
      magicMime: item.mime,
      extensionMismatch: scanItem.metadata.extensionMismatch === true,
      processorVersions: item.processorVersions,
      probe: item.probe,
    }), JSON.stringify({
      title: item.title,
      tags: [],
      origins: { title: "source", tags: "source" },
      merchant: null,
    }), now);
  }
  private ensureDerivatives(assetId: string, originalHash: string, files: PreparedFile[], item: Extract<ImportItemResult, {
    state: "committed";
  }>, now: string): void {
    for (const file of files) {
      if (file.role === "original")
        continue;
      const kind = file.role === "poster" ? "poster" : "video_preview";
      const recipeVersion = kind === "poster"
        ? item.kind === "video"
          ? "dcw-video-poster/1"
          : item.kind === "gif"
            ? "dcw-gif-poster/1"
            : "dcw-image-poster/1"
        : "dcw-video-preview/1";
      const recipe = {
        kind,
        processor: kind === "poster" ? "sharp/0.35.5" : "ffmpeg/8.1",
        recipeVersion,
      };
      const recipeHash = sha256Text(`${kind}:${recipeVersion}:${originalHash}`);
      this.db
        .prepare(`INSERT INTO derivatives(id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ready', ?) ON CONFLICT(asset_id, recipe_hash) DO NOTHING`)
        .run(randomUUID(), assetId, kind, JSON.stringify(recipe), recipeHash, file.sha256, now);
    }
  }
  private upsertOccurrence(input: {
    sourceVersionId: string;
    assetId: string | null;
    sectionId?: string | null;
    locator: OccurrenceLocator;
    positionKey?: string;
    occurrenceIndex: number;
    headingPath: string;
    beforeText: string;
    afterText: string;
    mediaStatus: "available" | "missing" | "unsupported";
    errorCode: string | null;
    now: string;
  }): string {
    const locatorJson = JSON.stringify(input.locator);
    const positionKey = input.positionKey ?? JSON.stringify(
      input.locator.kind === "markdown"
        ? [
            "markdown",
            input.locator.line,
            input.locator.column,
            input.locator.ordinal,
            input.locator.rawTarget,
          ]
        : input.locator.kind === "local_file"
          ? ["local_file", input.locator.relativePath]
          : [locatorKey(input.locator), input.occurrenceIndex],
    );
    this.db
      .prepare(`INSERT INTO occurrences
     (id, source_version_id, asset_id, section_id, locator_json, position_key, occurrence_index, heading_path,
      before_text, after_text, media_status, media_error_code, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(source_version_id, position_key) DO UPDATE SET
      asset_id = COALESCE(occurrences.asset_id, excluded.asset_id),
      media_status = CASE WHEN occurrences.asset_id IS NULL THEN excluded.media_status ELSE occurrences.media_status END,
      media_error_code = CASE WHEN occurrences.asset_id IS NULL THEN excluded.media_error_code ELSE occurrences.media_error_code END,
      updated_at = excluded.updated_at`)
      .run(
        randomUUID(),
        input.sourceVersionId,
        input.assetId,
        input.sectionId ?? null,
        locatorJson,
        positionKey,
        input.occurrenceIndex,
        input.headingPath,
        input.beforeText,
        input.afterText,
        input.mediaStatus,
        input.errorCode,
        input.now,
        input.now,
      );
    return z
      .strictObject({ id: z.uuid() })
      .parse(this.db
      .prepare("SELECT id FROM occurrences WHERE source_version_id = ? AND position_key = ?")
      .get(input.sourceVersionId, positionKey)).id;
  }
  private attachMarkdownOccurrences(importJobId: string, relativePath: string, assetId: string, now: string): void {
    this.db
      .prepare(`UPDATE occurrences SET asset_id = ?, media_status = 'available', media_error_code = NULL,
      updated_at = ?
     WHERE asset_id IS NULL
      AND json_extract(locator_json, '$.kind') = 'markdown'
      AND json_extract(locator_json, '$.normalizedRelativePath') = ?
      AND source_version_id IN (
       SELECT source_version_id FROM import_items
       WHERE import_job_id = ? AND state = 'committed' AND source_version_id IS NOT NULL
      )`)
      .run(assetId, now, relativePath, importJobId);
  }
  private workspaceFor(fence: WorkerFence): string {
    return join(this.dataRoot, "staging", "jobs", fence.jobId, `${fence.attempt}-${fence.leaseGeneration}`);
  }
}

function toAssetMapSelectedItem(item: ScanItemRecord): AssetMapSelectedItem {
  const kind =
    item.mediaKindGuess === "image" ||
    item.mediaKindGuess === "gif" ||
    item.mediaKindGuess === "video" ||
    item.mediaKindGuess === "markdown"
      ? item.mediaKindGuess
      : "unsupported";
  return {
    scanItemId: item.id,
    relativePath: item.relativePath,
    kind,
  };
}
interface PreparedFile extends StagedFile {
  absolute: string;
}
function requiredRoles(kind: string): StagedFile["role"][] {
  if (kind === "markdown" || kind === "document")
    return ["original"];
  if (kind === "video")
    return ["original", "poster", "video_preview"];
  return ["original", "poster"];
}

function documentSourceKind(
  format: "markdown" | "html" | "html_zip" | "pdf" | "pptx",
): string {
  switch (format) {
    case "markdown":
      return "local_markdown";
    case "html":
      return "local_html";
    case "html_zip":
      return "local_html_zip";
    case "pdf":
      return "local_pdf";
    case "pptx":
      return "local_pptx";
  }
}

function sha256Text(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function staleLease(): ApiError { return new ApiError({ statusCode: 409, code: "JOB_STALE_LEASE", message: "任务租约已失效，结果被拒绝" }); }
