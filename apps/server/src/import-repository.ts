import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ImportItemStateSchema,
  ImportItemStoredResultSchema,
  ScanCountsSchema,
  ScanItemResultSchema,
  ScanStatusSchema,
  UtcTimeSchema,
  type ImportItemState,
  type ImportItemStoredResult,
  type ImportItemView,
  type ScanCounts,
  type ScanExclusion,
  type ScanItemResult,
  type ScanItemStatus,
  type ScanItemView,
  type ScanStatus,
  type StagedDocumentMedia,
} from "@dmall/contracts";

const ScanRowSchema = z.strictObject({
  id: z.uuid(),
  job_id: z.uuid(),
  source_kind: z.enum(["local_directory", "upload"]),
  root_path: z.string().nullable(),
  root_identity: z.string().nullable(),
  status: ScanStatusSchema,
  scanner_version: z.string(),
  manifest_hash: z.string().nullable(),
  counts_json: z.string(),
  exclusions_json: z.string(),
  selection_hash: z.string().nullable(),
  import_job_id: z.uuid().nullable(),
  expires_at: UtcTimeSchema,
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
});

const ScanItemRowSchema = z.strictObject({
  id: z.uuid(),
  scan_id: z.uuid(),
  ordinal: z.int().nonnegative(),
  relative_path: z.string(),
  basename: z.string(),
  media_kind_guess: z.string(),
  mime_guess: z.string().nullable(),
  bytes: z.int().nonnegative(),
  mtime_ms: z.number(),
  device_id: z.string(),
  inode: z.string(),
  magic_prefix_hex: z.string().nullable(),
  status: z.enum(["candidate", "excluded", "unsupported", "unreadable"]),
  exclusion_code: z.string().nullable(),
  metadata_json: z.string(),
  created_at: UtcTimeSchema,
});

const ImportItemRowSchema = z.strictObject({
  id: z.uuid(),
  import_job_id: z.uuid(),
  scan_item_id: z.uuid(),
  state: ImportItemStateSchema,
  attempt: z.int().nonnegative(),
  error_json: z.string().nullable(),
  source_id: z.uuid().nullable(),
  source_version_id: z.uuid().nullable(),
  asset_id: z.uuid().nullable(),
  occurrence_id: z.uuid().nullable(),
  planned_source_version_id: z.uuid().nullable(),
  result_json: z.string(),
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
});

const UploadSessionRowSchema = z.strictObject({
  id: z.uuid(),
  relative_path: z.string(),
  file_name: z.string(),
  declared_bytes: z.int().nonnegative(),
  received_bytes: z.int().nonnegative(),
  chunk_count: z.int().positive(),
  next_chunk: z.int().nonnegative(),
  status: z.enum(["uploading", "complete", "scan_ready", "expired", "failed"]),
  staging_relative_path: z.string(),
  sha256: z.string().nullable(),
  mime: z.string().nullable(),
  scan_id: z.uuid().nullable(),
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
  expires_at: UtcTimeSchema.nullable(),
});

const UploadChunkRowSchema = z.strictObject({
  session_id: z.uuid(),
  chunk_index: z.int().nonnegative(),
  sha256: z.string(),
  bytes: z.int().nonnegative(),
  relative_path: z.string(),
});

const StagedDocumentMediaRowSchema = z.strictObject({
  batch_index: z.int().nonnegative(),
  batch_count: z.int().positive(),
  adapter_id: z.string().min(1),
  media_kind: z.enum(["image", "gif", "video", "audio", "other"]),
  media_status: z.literal("extracted"),
  source_internal_path: z.string(),
  relative_path: z.string(),
  sha256: z.string(),
  bytes: z.int().nonnegative(),
  mime: z.string(),
  role: z.enum(["document_media", "page_image"]),
});

export interface ScanRecord {
  id: string;
  jobId: string;
  sourceKind: "local_directory" | "upload";
  rootPath: string | null;
  rootIdentity: string | null;
  status: ScanStatus;
  scannerVersion: string;
  manifestHash: string | null;
  counts: ScanCounts;
  exclusions: ScanExclusion[];
  selectionHash: string | null;
  importJobId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScanItemRecord {
  id: string;
  scanId: string;
  ordinal: number;
  relativePath: string;
  basename: string;
  mediaKindGuess: string;
  mimeGuess: string | null;
  bytes: number;
  mtimeMs: number;
  deviceId: string;
  inode: string;
  magicPrefixHex: string | null;
  status: ScanItemStatus;
  exclusionCode: string | null;
  metadata: ScanItemResult["metadata"];
  createdAt: string;
}

export interface ImportItemRecord {
  id: string;
  importJobId: string;
  scanItemId: string;
  state: ImportItemState;
  attempt: number;
  error: { code: string; message: string; retryable: boolean } | null;
  sourceId: string | null;
  sourceVersionId: string | null;
  assetId: string | null;
  occurrenceId: string | null;
  plannedSourceVersionId: string | null;
  result: ImportItemStoredResult;
  createdAt: string;
  updatedAt: string;
}

export interface UploadSessionRecord {
  id: string;
  relativePath: string;
  fileName: string;
  declaredBytes: number;
  receivedBytes: number;
  chunkCount: number;
  nextChunk: number;
  status: "uploading" | "complete" | "scan_ready" | "expired" | "failed";
  stagingRelativePath: string;
  sha256: string | null;
  mime: string | null;
  scanId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export class ImportRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insertScan(input: {
    id: string;
    jobId: string;
    sourceKind: "local_directory" | "upload";
    rootPath: string | null;
    rootIdentity: string | null;
    expiresAt: string;
  }): ScanRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO import_scans
          (id, job_id, source_kind, root_path, root_identity, status, scanner_version,
           manifest_hash, counts_json, exclusions_json, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 'dcw-directory-scan/1', NULL, ?, '[]', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.jobId,
        input.sourceKind,
        input.rootPath,
        input.rootIdentity,
        JSON.stringify(zeroCounts()),
        input.expiresAt,
        now,
        now,
      );
    return this.requireScan(input.id);
  }

  getScan(id: string): ScanRecord | null {
    const row = this.db.prepare("SELECT * FROM import_scans WHERE id = ?").get(id);
    return row === undefined ? null : parseScan(row);
  }

  requireScan(id: string): ScanRecord {
    const scan = this.getScan(id);
    if (scan === null) {
      throw Object.assign(new Error("扫描不存在"), { code: "SCAN_NOT_FOUND" });
    }
    return scan;
  }

  setScanStatus(id: string, status: ScanStatus, phase?: string): void {
    this.db
      .prepare("UPDATE import_scans SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    if (phase !== undefined) {
      this.db.prepare("UPDATE jobs SET phase = ?, updated_at = ? WHERE id = (SELECT job_id FROM import_scans WHERE id = ?)").run(
        phase,
        new Date().toISOString(),
        id,
      );
    }
  }

  upsertScanItem(scanId: string, item: ScanItemResult): ScanItemRecord {
    const existing = this.findScanItemByPath(scanId, item.relativePath);
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const ordinal = existing?.ordinal ?? this.nextScanOrdinal(scanId);
    this.db
      .prepare(
        `INSERT INTO scan_items
          (id, scan_id, ordinal, relative_path, basename, media_kind_guess, mime_guess, bytes,
           mtime_ms, device_id, inode, magic_prefix_hex, status, exclusion_code, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scan_id, relative_path) DO UPDATE SET
           media_kind_guess = excluded.media_kind_guess,
           mime_guess = excluded.mime_guess,
           bytes = excluded.bytes,
           mtime_ms = excluded.mtime_ms,
           device_id = excluded.device_id,
           inode = excluded.inode,
           magic_prefix_hex = excluded.magic_prefix_hex,
           status = excluded.status,
           exclusion_code = excluded.exclusion_code,
           metadata_json = excluded.metadata_json`,
      )
      .run(
        id,
        scanId,
        ordinal,
        item.relativePath,
        item.basename,
        item.kind,
        item.mime,
        item.bytes,
        item.mtimeMs,
        item.deviceId,
        item.inode,
        item.magicPrefixHex === "" ? null : item.magicPrefixHex,
        item.status,
        item.exclusionCode,
        JSON.stringify(item.metadata),
        now,
      );
    return this.requireScanItem(id);
  }

  findScanItemByPath(scanId: string, relativePath: string): ScanItemRecord | null {
    const row = this.db
      .prepare("SELECT * FROM scan_items WHERE scan_id = ? AND relative_path = ?")
      .get(scanId, relativePath);
    return row === undefined ? null : parseScanItem(row);
  }

  requireScanItem(id: string): ScanItemRecord {
    const row = this.db.prepare("SELECT * FROM scan_items WHERE id = ?").get(id);
    if (row === undefined) {
      throw Object.assign(new Error("扫描项目不存在"), { code: "SCAN_ITEM_NOT_FOUND" });
    }
    return parseScanItem(row);
  }

  scanItems(scanId: string, options: {
    status?: ScanItemStatus;
    kind?: string;
    limit: number;
    offset: number;
  }): { items: ScanItemRecord[]; total: number } {
    const clauses = ["scan_id = ?"];
    const params: unknown[] = [scanId];
    if (options.status !== undefined) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.kind !== undefined) {
      clauses.push("media_kind_guess = ?");
      params.push(options.kind);
    }
    const where = clauses.join(" AND ");
    const total = z
      .strictObject({ count: z.int().nonnegative() })
      .parse(this.db.prepare(`SELECT COUNT(*) AS count FROM scan_items WHERE ${where}`).get(...params)).count;
    const rows = z
      .array(z.unknown())
      .parse(
        this.db
          .prepare(
            `SELECT * FROM scan_items WHERE ${where} ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?`,
          )
          .all(...params, options.limit, options.offset),
      );
    return { items: rows.map(parseScanItem), total };
  }

  candidateScanItems(scanId: string): ScanItemRecord[] {
    return z
      .array(z.unknown())
      .parse(
        this.db
          .prepare("SELECT * FROM scan_items WHERE scan_id = ? AND status = 'candidate' ORDER BY ordinal ASC, id ASC")
          .all(scanId),
      )
      .map(parseScanItem);
  }

  scanCounts(scanId: string): { counts: ScanCounts; exclusions: ScanExclusion[] } {
    const aggregate = z
      .strictObject({
        candidate: z.int(),
        excluded: z.int(),
        unsupported: z.int(),
        unreadable: z.int(),
        mp4: z.int(),
        gif: z.int(),
        image: z.int(),
        markdown: z.int(),
        pdf: z.int(),
        pptx: z.int(),
        html: z.int(),
        htmlZip: z.int(),
        totalBytes: z.int(),
      })
      .parse(
        this.db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END), 0) AS candidate,
               COALESCE(SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END), 0) AS excluded,
               COALESCE(SUM(CASE WHEN status = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported,
               COALESCE(SUM(CASE WHEN status = 'unreadable' THEN 1 ELSE 0 END), 0) AS unreadable,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'video' THEN 1 ELSE 0 END), 0) AS mp4,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'gif' THEN 1 ELSE 0 END), 0) AS gif,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'image' THEN 1 ELSE 0 END), 0) AS image,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'markdown' THEN 1 ELSE 0 END), 0) AS markdown,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'pdf' THEN 1 ELSE 0 END), 0) AS pdf,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'pptx' THEN 1 ELSE 0 END), 0) AS pptx,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'html' THEN 1 ELSE 0 END), 0) AS html,
               COALESCE(SUM(CASE WHEN status = 'candidate' AND media_kind_guess = 'html_zip' THEN 1 ELSE 0 END), 0) AS htmlZip,
               COALESCE(SUM(CASE WHEN status = 'candidate' THEN bytes ELSE 0 END), 0) AS totalBytes
             FROM scan_items WHERE scan_id = ?`,
          )
          .get(scanId),
      );
    const exclusions = z
      .array(
        z.strictObject({
          code: z.string(),
          count: z.int(),
          examples: z.string(),
        }),
      )
      .parse(
        this.db
          .prepare(
            `SELECT exclusion_code AS code, COUNT(*) AS count,
                    json_group_array(relative_path) AS examples
             FROM (SELECT exclusion_code, relative_path FROM scan_items
                   WHERE scan_id = ? AND exclusion_code IS NOT NULL
                   ORDER BY ordinal ASC LIMIT 200)
             GROUP BY exclusion_code ORDER BY count DESC`,
          )
          .all(scanId),
      )
      .map((row) => ({
        code: row.code,
        count: row.count,
        examples: z.array(z.string()).parse(JSON.parse(row.examples)).slice(0, 5),
      }));
    return {
      counts: ScanCountsSchema.parse(aggregate),
      exclusions,
    };
  }

  finalizeScan(scanId: string, options: {
    status: "ready" | "failed" | "cancelled";
    manifestHash: string | null;
  }): void {
    const { counts, exclusions } = this.scanCounts(scanId);
    this.db
      .prepare(
        `UPDATE import_scans SET status = ?, manifest_hash = ?, counts_json = ?, exclusions_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        options.status,
        options.manifestHash,
        JSON.stringify(counts),
        JSON.stringify(exclusions),
        new Date().toISOString(),
        scanId,
      );
  }

  consumeScan(scanId: string, selectionHash: string, importJobId: string): void {
    this.db
      .prepare(
        "UPDATE import_scans SET status = 'consumed', selection_hash = ?, import_job_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(selectionHash, importJobId, new Date().toISOString(), scanId);
  }

  createImportItems(importJobId: string, scanItems: ScanItemRecord[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO import_items
        (id, import_job_id, scan_item_id, state, attempt, error_json, source_id,
         source_version_id, asset_id, occurrence_id, planned_source_version_id,
         result_json, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?, '{}', ?, ?)`,
    );
    for (const item of scanItems) {
      insert.run(randomUUID(), importJobId, item.id, randomUUID(), now, now);
    }
  }

  importItems(importJobId: string, options?: {
    limit?: number;
    offset?: number;
    onlyRetryable?: boolean;
  }): { items: ImportItemRecord[]; total: number } {
    const where = options?.onlyRetryable === true
      ? "ii.import_job_id = ? AND ii.state IN ('failed', 'skipped', 'pending')"
      : "ii.import_job_id = ?";
    const total = z
      .strictObject({ count: z.int().nonnegative() })
      .parse(this.db.prepare(`SELECT COUNT(*) AS count FROM import_items ii WHERE ${where}`).get(importJobId)).count;
    const rows = z
      .array(z.unknown())
      .parse(
        this.db
          .prepare(
            `SELECT ii.* FROM import_items ii
             JOIN scan_items si ON si.id = ii.scan_item_id
             WHERE ${where}
             ORDER BY si.ordinal ASC, ii.id ASC LIMIT ? OFFSET ?`,
          )
          .all(importJobId, options?.limit ?? 100, options?.offset ?? 0),
      );
    return { items: rows.map(parseImportItem), total };
  }

  executionItems(importJobId: string): ImportItemRecord[] {
    return this.db.prepare(`SELECT ii.* FROM import_items ii JOIN scan_items si ON si.id = ii.scan_item_id
      WHERE ii.import_job_id = ? ORDER BY si.ordinal, si.id`).all(importJobId).map(parseImportItem);
  }

  selectedScanItems(importJobId: string): ScanItemRecord[] {
    return z
      .array(z.unknown())
      .parse(
        this.db
          .prepare(
            `SELECT si.* FROM scan_items si
             JOIN import_items ii ON ii.scan_item_id = si.id
             WHERE ii.import_job_id = ?
             ORDER BY si.ordinal ASC, si.id ASC`,
          )
          .all(importJobId),
      )
      .map(parseScanItem);
  }

  importItemByScanItem(importJobId: string, scanItemId: string): ImportItemRecord | null {
    const row = this.db
      .prepare("SELECT * FROM import_items WHERE import_job_id = ? AND scan_item_id = ?")
      .get(importJobId, scanItemId);
    return row === undefined ? null : parseImportItem(row);
  }

  setImportItemState(input: {
    id: string;
    state: ImportItemState;
    error?: { code: string; message: string; retryable: boolean } | null;
    sourceId?: string | null;
    sourceVersionId?: string | null;
    assetId?: string | null;
    occurrenceId?: string | null;
    result?: ImportItemStoredResult;
    attempt?: number;
  }): void {
    this.db
      .prepare(
        `UPDATE import_items SET state = ?, error_json = ?, source_id = COALESCE(?, source_id),
           source_version_id = COALESCE(?, source_version_id), asset_id = COALESCE(?, asset_id),
           occurrence_id = COALESCE(?, occurrence_id), result_json = ?, attempt = COALESCE(?, attempt),
           updated_at = ? WHERE id = ?`,
      )
      .run(
        input.state,
        input.error === undefined || input.error === null ? null : JSON.stringify(input.error),
        input.sourceId ?? null,
        input.sourceVersionId ?? null,
        input.assetId ?? null,
        input.occurrenceId ?? null,
        JSON.stringify(input.result ?? {}),
        input.attempt ?? null,
        new Date().toISOString(),
        input.id,
      );
  }

  resetImportItemsForRetry(importJobId: string, itemIds: readonly string[]): number {
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE import_items SET state = 'pending', error_json = NULL, attempt = attempt + 1, updated_at = ?
       WHERE id = ? AND import_job_id = ? AND state IN ('failed', 'skipped', 'pending')`,
    );
    let changed = 0;
    for (const id of itemIds) {
      changed += update.run(now, id, importJobId).changes;
    }
    return changed;
  }

  importCounts(importJobId: string): {
    pending: number;
    committed: number;
    failed: number;
    skipped: number;
    total: number;
  } {
    return z
      .strictObject({
        pending: z.int(),
        committed: z.int(),
        failed: z.int(),
        skipped: z.int(),
        total: z.int(),
      })
      .parse(
        this.db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN state IN ('pending','copying','probing','previewing') THEN 1 ELSE 0 END),0) AS pending,
               COALESCE(SUM(CASE WHEN state = 'committed' THEN 1 ELSE 0 END),0) AS committed,
               COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END),0) AS failed,
               COALESCE(SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END),0) AS skipped,
               COUNT(*) AS total
             FROM import_items WHERE import_job_id = ?`,
          )
          .get(importJobId),
      );
  }

  committedAssetIds(importJobId: string): string[] {
    return z
      .array(z.strictObject({ asset_id: z.uuid() }))
      .parse(
        this.db
          .prepare(
            "SELECT DISTINCT asset_id FROM import_items WHERE import_job_id = ? AND asset_id IS NOT NULL ORDER BY asset_id",
          )
          .all(importJobId),
      )
      .map((row) => row.asset_id);
  }

  hasPartialDocuments(importJobId: string): boolean {
    return z
      .strictObject({ count: z.int().nonnegative() })
      .parse(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM import_items
             WHERE import_job_id = ?
               AND state = 'committed'
               AND COALESCE(json_extract(result_json, '$.documentFormat'), '') <> 'markdown'
               AND json_extract(result_json, '$.documentStatus') IN ('partial', 'blocked')`,
          )
          .get(importJobId),
      ).count > 0;
  }

  committedAssetForPath(importJobId: string, relativePath: string): string | null {
    const row = this.db
      .prepare(
        `SELECT ii.asset_id
         FROM import_items ii JOIN scan_items si ON si.id = ii.scan_item_id
         WHERE ii.import_job_id = ? AND si.relative_path = ? AND ii.state = 'committed'
           AND ii.asset_id IS NOT NULL
         ORDER BY si.ordinal ASC LIMIT 1`,
      )
      .get(importJobId, relativePath);
    if (row === undefined) return null;
    return z.strictObject({ asset_id: z.uuid() }).parse(row).asset_id;
  }

  upsertAssetMapEntries(input: {
    importJobId: string;
    scanId: string;
    mappingScanItemId: string;
    mappingSourceVersionId: string;
    mapIndex: number;
    entries: readonly {
      tableIndex: number;
      rowIndex: number;
      rowKey: string;
      sectionHeading: string;
      fileCell: string;
      normalizedRelativePath: string;
      titleText: string | null;
      usageMarkdown: string;
      usageText: string;
      lineStart: number;
      lineEnd: number;
    }[];
    now: string;
  }): void {
    const statement = this.db.prepare(
      `INSERT INTO asset_map_entries
        (id, import_job_id, scan_id, mapping_scan_item_id, mapping_source_version_id,
         map_index, table_index, row_index, row_key, section_heading, file_cell,
         normalized_relative_path, title_text, usage_markdown, usage_text,
         line_start, line_end, parser_version, asset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dcw-asset-map/1', NULL, ?, ?)
       ON CONFLICT(import_job_id, mapping_source_version_id, row_key) DO UPDATE SET
         map_index = excluded.map_index,
         table_index = excluded.table_index,
         row_index = excluded.row_index,
         section_heading = excluded.section_heading,
         file_cell = excluded.file_cell,
         normalized_relative_path = excluded.normalized_relative_path,
         title_text = excluded.title_text,
         usage_markdown = excluded.usage_markdown,
         usage_text = excluded.usage_text,
         line_start = excluded.line_start,
         line_end = excluded.line_end,
         updated_at = excluded.updated_at`,
    );
    for (const entry of input.entries) {
      statement.run(
        randomUUID(),
        input.importJobId,
        input.scanId,
        input.mappingScanItemId,
        input.mappingSourceVersionId,
        input.mapIndex,
        entry.tableIndex,
        entry.rowIndex,
        entry.rowKey,
        entry.sectionHeading,
        entry.fileCell,
        entry.normalizedRelativePath,
        entry.titleText,
        entry.usageMarkdown,
        entry.usageText,
        entry.lineStart,
        entry.lineEnd,
        input.now,
        input.now,
      );
    }
  }

  linkAssetMapEntries(input: {
    importJobId: string;
    normalizedRelativePath: string;
    assetId: string;
    now: string;
  }): number {
    return this.db
      .prepare(
        `UPDATE asset_map_entries
         SET asset_id = ?, updated_at = ?
         WHERE import_job_id = ? AND normalized_relative_path = ? AND asset_id IS NULL`,
      )
      .run(input.assetId, input.now, input.importJobId, input.normalizedRelativePath)
      .changes;
  }

  backfillAssetMapEntries(input: {
    importJobId: string;
    mappingSourceVersionId: string;
    now: string;
  }): number {
    return this.db
      .prepare(
        `UPDATE asset_map_entries AS e
         SET asset_id = (
           SELECT ii.asset_id
           FROM import_items ii
           JOIN scan_items si ON si.id = ii.scan_item_id
           WHERE ii.import_job_id = e.import_job_id
             AND ii.state = 'committed'
             AND ii.asset_id IS NOT NULL
             AND si.relative_path = e.normalized_relative_path
           ORDER BY si.ordinal ASC, si.id ASC
           LIMIT 1
         ), updated_at = ?
         WHERE e.import_job_id = ?
           AND e.mapping_source_version_id = ?
           AND e.asset_id IS NULL
           AND EXISTS (
             SELECT 1
             FROM import_items ii
             JOIN scan_items si ON si.id = ii.scan_item_id
             WHERE ii.import_job_id = e.import_job_id
               AND ii.state = 'committed'
               AND ii.asset_id IS NOT NULL
               AND si.relative_path = e.normalized_relative_path
           )`,
      )
      .run(input.now, input.importJobId, input.mappingSourceVersionId).changes;
  }

  mappingEntryCounts(importJobId: string, mappingSourceVersionId: string): {
    entryCount: number;
    linkedEntryCount: number;
  } {
    return z
      .strictObject({
        entryCount: z.int().nonnegative(),
        linkedEntryCount: z.int().nonnegative(),
      })
      .parse(
        this.db
          .prepare(
            `SELECT COUNT(*) AS entryCount,
                    COUNT(DISTINCT asset_id) AS linkedEntryCount
             FROM asset_map_entries
             WHERE import_job_id = ? AND mapping_source_version_id = ?`,
          )
          .get(importJobId, mappingSourceVersionId),
      );
  }

  mappingEntryCountsBySource(importJobId: string): Map<string, {
    entryCount: number;
    linkedEntryCount: number;
  }> {
    const rows = z
      .array(
        z.strictObject({
          mapping_source_version_id: z.uuid(),
          entry_count: z.int().nonnegative(),
          linked_entry_count: z.int().nonnegative(),
        }),
      )
      .parse(
        this.db
          .prepare(
            `SELECT mapping_source_version_id,
                    COUNT(*) AS entry_count,
                    COUNT(DISTINCT asset_id) AS linked_entry_count
             FROM asset_map_entries
             WHERE import_job_id = ?
             GROUP BY mapping_source_version_id`,
          )
          .all(importJobId),
      );
    return new Map(
      rows.map((row) => [
        row.mapping_source_version_id,
        { entryCount: row.entry_count, linkedEntryCount: row.linked_entry_count },
      ]),
    );
  }

  mappingLinkedAssetCount(importJobId: string): number {
    return z
      .strictObject({ count: z.int().nonnegative() })
      .parse(
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT asset_id) AS count
             FROM asset_map_entries
             WHERE import_job_id = ? AND asset_id IS NOT NULL`,
          )
          .get(importJobId),
      ).count;
  }

  failOpenImportItems(importJobId: string, state: "failed" | "skipped", code: string, message: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE import_items SET state = ?, error_json = ?, updated_at = ?
         WHERE import_job_id = ? AND state IN ('pending', 'copying', 'probing', 'previewing')`,
      )
      .run(state, JSON.stringify({ code, message, retryable: false }), now, importJobId);
  }

  upsertStagedDocumentMedia(input: {
    jobId: string;
    scanItemId: string;
    batchIndex: number;
    batchCount: number;
    media: readonly StagedDocumentMedia[];
  }): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      `SELECT batch_index, batch_count, adapter_id, media_kind, media_status,
              source_internal_path, relative_path, sha256, bytes, mime, role
       FROM import_staged_files WHERE job_id = ? AND scan_item_id = ? AND adapter_id = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO import_staged_files(
        job_id, scan_item_id, batch_index, batch_count, adapter_id, media_kind,
        media_status, source_internal_path, relative_path, sha256, bytes, mime,
        role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, scan_item_id, adapter_id) DO NOTHING`,
    );
    for (const media of input.media) {
      const priorRaw = existing.get(input.jobId, input.scanItemId, media.adapterId);
      if (priorRaw !== undefined) {
        const prior = StagedDocumentMediaRowSchema.parse(priorRaw);
        if (
          prior.batch_index !== input.batchIndex ||
          prior.batch_count !== input.batchCount ||
          prior.sha256 !== media.sha256 ||
          prior.bytes !== media.bytes ||
          prior.relative_path !== media.relativePath
        ) {
          throw Object.assign(new Error("同一媒体批次被不同内容重复提交"), {
            code: "STAGED_MEDIA_CONFLICT",
          });
        }
        continue;
      }
      insert.run(
        input.jobId,
        input.scanItemId,
        input.batchIndex,
        input.batchCount,
        media.adapterId,
        media.mediaKind,
        media.mediaStatus,
        media.sourceInternalPath,
        media.relativePath,
        media.sha256,
        media.bytes,
        media.mime,
        media.role,
        now,
      );
    }
  }

  stagedDocumentMedia(jobId: string, scanItemId: string): StagedDocumentMedia[] {
    const rows = z
      .array(StagedDocumentMediaRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT batch_index, batch_count, adapter_id, media_kind, media_status,
                    source_internal_path, relative_path, sha256, bytes, mime, role
             FROM import_staged_files
             WHERE job_id = ? AND scan_item_id = ?
             ORDER BY batch_index ASC, adapter_id ASC`,
          )
          .all(jobId, scanItemId),
      );
    return rows.map((row) => ({
      adapterId: row.adapter_id,
      mediaKind: row.media_kind,
      mediaStatus: row.media_status,
      sourceInternalPath: row.source_internal_path,
      relativePath: row.relative_path,
      sha256: row.sha256,
      bytes: row.bytes,
      mime: row.mime,
      role: row.role,
    }));
  }

  insertUploadSession(input: {
    id: string;
    relativePath: string;
    fileName: string;
    declaredBytes: number;
    chunkCount: number;
    stagingRelativePath: string;
    expiresAt: string;
  }): UploadSessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO upload_sessions
          (id, relative_path, file_name, declared_bytes, received_bytes, chunk_count, next_chunk,
           status, staging_relative_path, sha256, mime, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 0, ?, 0, 'uploading', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.relativePath,
        input.fileName,
        input.declaredBytes,
        input.chunkCount,
        input.stagingRelativePath,
        now,
        now,
        input.expiresAt,
      );
    return this.requireUploadSession(input.id);
  }

  getUploadSession(id: string): UploadSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM upload_sessions WHERE id = ?").get(id);
    return row === undefined ? null : parseUploadSession(row);
  }

  requireUploadSession(id: string): UploadSessionRecord {
    const session = this.getUploadSession(id);
    if (session === null) {
      throw Object.assign(new Error("上传会话不存在"), { code: "UPLOAD_NOT_FOUND" });
    }
    return session;
  }

  uploadChunk(sessionId: string, index: number): z.infer<typeof UploadChunkRowSchema> | null {
    const row = this.db
      .prepare("SELECT session_id, chunk_index, sha256, bytes, relative_path FROM upload_chunks WHERE session_id = ? AND chunk_index = ?")
      .get(sessionId, index);
    return row === undefined ? null : UploadChunkRowSchema.parse(row);
  }

  uploadChunks(sessionId: string): z.infer<typeof UploadChunkRowSchema>[] {
    return z
      .array(UploadChunkRowSchema)
      .parse(
        this.db
          .prepare(
            "SELECT session_id, chunk_index, sha256, bytes, relative_path FROM upload_chunks WHERE session_id = ? ORDER BY chunk_index ASC",
          )
          .all(sessionId),
      );
  }

  recordUploadChunk(input: {
    sessionId: string;
    index: number;
    sha256: string;
    bytes: number;
    relativePath: string;
  }): UploadSessionRecord {
    return this.db.transaction(() => {
      const session = this.requireUploadSession(input.sessionId);
      const existing = this.uploadChunk(input.sessionId, input.index);
      if (existing !== null) {
        if (existing.sha256 !== input.sha256 || existing.bytes !== input.bytes) {
          throw Object.assign(new Error("分块内容与已保存分块不一致"), { code: "UPLOAD_ORDER_INVALID" });
        }
        return session;
      }
      if (session.nextChunk !== input.index) {
        throw Object.assign(new Error(`期望分块 ${session.nextChunk}，收到 ${input.index}`), {
          code: "UPLOAD_ORDER_INVALID",
        });
      }
      if (session.status !== "uploading" || session.receivedBytes + input.bytes > Math.min(session.declaredBytes, 2 * 1024 ** 3)) {
        throw Object.assign(new Error("上传超出声明容量"), {code:"PAYLOAD_TOO_LARGE"});
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO upload_chunks(session_id, chunk_index, sha256, bytes, relative_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.sessionId, input.index, input.sha256, input.bytes, input.relativePath, now);
      this.db
        .prepare(
          `UPDATE upload_sessions SET received_bytes = received_bytes + ?, next_chunk = next_chunk + 1,
             updated_at = ? WHERE id = ?`,
        )
        .run(input.bytes, now, input.sessionId);
      return this.requireUploadSession(input.sessionId);
    })();
  }

  completeUploadSession(input: {
    id: string;
    sha256: string;
    bytes: number;
    mime: string;
    assembledRelativePath: string;
  }): UploadSessionRecord {
    this.db
      .prepare(
        `UPDATE upload_sessions SET status = 'complete', sha256 = ?, received_bytes = ?, mime = ?,
           staging_relative_path = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.sha256,
        input.bytes,
        input.mime,
        input.assembledRelativePath,
        new Date().toISOString(),
        input.id,
      );
    return this.requireUploadSession(input.id);
  }

  uploadSessionsForScan(scanId: string): UploadSessionRecord[] {
    return this.db.prepare(`SELECT us.* FROM upload_sessions us
      JOIN import_scans sc ON sc.id = ? JOIN jobs j ON j.id = sc.job_id
      WHERE us.id IN (SELECT value FROM json_each(j.input_json, '$.fileIds'))
      ORDER BY us.relative_path`).all(scanId).map(parseUploadSession);
  }

  private nextScanOrdinal(scanId: string): number {
    return z
      .strictObject({ next: z.int().nonnegative() })
      .parse(
        this.db
          .prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM scan_items WHERE scan_id = ?")
          .get(scanId),
      ).next;
  }
}

export function zeroCounts(): ScanCounts {
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

export function scanItemView(item: ScanItemRecord): ScanItemView {
  return {
    id: item.id,
    relativePath: item.relativePath,
    basename: item.basename,
    kind:
      item.mediaKindGuess === "image" ||
      item.mediaKindGuess === "gif" ||
      item.mediaKindGuess === "video" ||
      item.mediaKindGuess === "markdown" ||
      item.mediaKindGuess === "pdf" ||
      item.mediaKindGuess === "pptx" ||
      item.mediaKindGuess === "html" ||
      item.mediaKindGuess === "html_zip"
        ? item.mediaKindGuess
        : "unsupported",
    mime: item.mimeGuess,
    bytes: item.bytes,
    status: item.status,
    reasonCode: item.exclusionCode,
    reason: reasonText(item.exclusionCode),
  };
}

export function importItemView(
  item: ImportItemRecord,
  scanItem: ScanItemRecord,
): ImportItemView {
  return {
    id: item.id,
    scanItemId: item.scanItemId,
    relativePath: scanItem.relativePath,
    state: item.state,
    attempt: item.attempt,
    assetId: item.assetId,
    sourceVersionId: item.sourceVersionId,
    occurrenceId: item.occurrenceId,
    documentStatus: item.result.documentStatus ?? null,
    errorCode: item.error?.code ?? null,
    errorMessage: item.error?.message ?? null,
  };
}

function parseScan(raw: unknown): ScanRecord {
  const row = ScanRowSchema.parse(raw);
  return {
    id: row.id,
    jobId: row.job_id,
    sourceKind: row.source_kind,
    rootPath: row.root_path,
    rootIdentity: row.root_identity,
    status: row.status,
    scannerVersion: row.scanner_version,
    manifestHash: row.manifest_hash,
    counts: ScanCountsSchema.parse(JSON.parse(row.counts_json)),
    exclusions: z.array(
      z.strictObject({ code: z.string(), count: z.int(), examples: z.array(z.string()) }),
    ).parse(JSON.parse(row.exclusions_json)),
    selectionHash: row.selection_hash,
    importJobId: row.import_job_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseScanItem(raw: unknown): ScanItemRecord {
  const row = ScanItemRowSchema.parse(raw);
  return {
    id: row.id,
    scanId: row.scan_id,
    ordinal: row.ordinal,
    relativePath: row.relative_path,
    basename: row.basename,
    mediaKindGuess: row.media_kind_guess,
    mimeGuess: row.mime_guess,
    bytes: row.bytes,
    mtimeMs: row.mtime_ms,
    deviceId: row.device_id,
    inode: row.inode,
    magicPrefixHex: row.magic_prefix_hex,
    status: row.status,
    exclusionCode: row.exclusion_code,
    metadata: ScanItemResultSchema.shape.metadata.parse(JSON.parse(row.metadata_json)),
    createdAt: row.created_at,
  };
}

function parseImportItem(raw: unknown): ImportItemRecord {
  const row = ImportItemRowSchema.parse(raw);
  return {
    id: row.id,
    importJobId: row.import_job_id,
    scanItemId: row.scan_item_id,
    state: row.state,
    attempt: row.attempt,
    error:
      row.error_json === null
        ? null
        : z
            .strictObject({ code: z.string(), message: z.string(), retryable: z.boolean() })
            .parse(JSON.parse(row.error_json)),
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    assetId: row.asset_id,
    occurrenceId: row.occurrence_id,
    plannedSourceVersionId: row.planned_source_version_id,
    result: ImportItemStoredResultSchema.parse(JSON.parse(row.result_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseUploadSession(raw: unknown): UploadSessionRecord {
  const row = UploadSessionRowSchema.parse(raw);
  return {
    id: row.id,
    relativePath: row.relative_path,
    fileName: row.file_name,
    declaredBytes: row.declared_bytes,
    receivedBytes: row.received_bytes,
    chunkCount: row.chunk_count,
    nextChunk: row.next_chunk,
    status: row.status,
    stagingRelativePath: row.staging_relative_path,
    sha256: row.sha256,
    mime: row.mime,
    scanId: row.scan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function reasonText(code: string | null): string | null {
  switch (code) {
    case "EXCLUDED_DIRECTORY":
      return "目录在排除列表中，未遍历";
    case "EXCLUDED_FILE":
      return "文件属于排除规则";
    case "SYMLINK_OUTSIDE_ROOT":
      return "符号链接指向扫描根之外";
    case "SYMLINK_NOT_FOLLOWED":
      return "符号链接不跟随";
    case "SINGLE_FILE_LIMIT":
      return "单文件超过 2GiB";
    case "UNSUPPORTED_FORMAT":
    case "UNSUPPORTED_FILE_TYPE":
      return "格式不在本阶段支持范围";
    case "SOURCE_UNREADABLE":
      return "文件不可读";
    default:
      return null;
  }
}
