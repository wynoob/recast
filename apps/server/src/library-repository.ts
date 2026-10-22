import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AssetDetailV2Schema,
  AssetFieldOriginsSchema,
  AssetMetadataSchema,
  AssetPatchResultSchema,
  AssetSourceSuggestionSchema,
  AssetSummaryV2Schema,
  OccurrenceLocatorSchema,
  PatchAssetRequestSchema,
  SourceSummarySchema,
  SourceContextSchema,
  UtcTimeSchema,
  type AssetAvailability,
  type AssetDetailV2,
  type AssetPatchResult,
  type AssetSourceSuggestion,
  type AssetSummaryV2,
  type SourceSummary,
  type PatchAssetRequest,
  type SourceContext,
} from "@dmall/contracts";
import { normalizeTags, normalizeTitle } from "@dmall/domain";
import type { BlobStore } from "@dmall/storage";
import { ApiError } from "./errors.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type { WriteContext } from "./import-service.js";
import type { DocumentRepository } from "./documents/repository.js";
import type { KeywordIndexService } from "./retrieval/index-service.js";

const AssetRowSchema = z.strictObject({
  id: z.uuid(),
  media_kind: z.enum(["image", "gif", "video", "document", "audio"]),
  blob_hash: z.string(),
  created_at: UtcTimeSchema,
  mime: z.string(),
  bytes: z.int().nonnegative(),
  title: z.string().nullable(),
  version: z.int().nonnegative().nullable(),
  metadata_json: z.string().nullable(),
  human_fields_json: z.string().nullable(),
  source_count: z.int().nonnegative(),
  occurrence_count: z.int().nonnegative(),
});

const CountRowSchema = z.strictObject({ count: z.int().nonnegative() });

const HumanFieldsSchema = z.object({
  title: z.string().default(""),
  tags: z.array(z.string()).default([]),
  origins: AssetFieldOriginsSchema.default({ title: "source", tags: "source" }),
  merchant: z.string().nullable().default(null),
});

const SourceRowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  status: z.enum(["active", "archived"]),
  current_version_id: z.uuid().nullable(),
  occurrence_count: z.int().nonnegative(),
  missing_occurrence_count: z.int().nonnegative(),
  linked_asset_count: z.int().nonnegative(),
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
});

const OccurrenceRowSchema = z.strictObject({
  id: z.uuid(),
  source_version_id: z.uuid(),
  source_id: z.uuid(),
  source_title: z.string(),
  source_relative_path: z.string().nullable(),
  locator_json: z.string(),
  heading_path: z.string(),
  before_text: z.string(),
  after_text: z.string(),
  media_status: z.enum(["discovered", "available", "missing", "unsupported"]),
  media_error_code: z.string().nullable(),
});

export interface AssetFilters {
  q?: string;
  type?: "image" | "gif" | "video";
  state?: AssetAvailability;
  merchant?: string;
  limit: number;
  offset: number;
}

export class LibraryRepository {
  private readonly db: Database.Database;
  private readonly blobs: BlobStore;
  private readonly idempotency: IdempotencyRepository;
  private readonly documents: DocumentRepository;
  private readonly index: KeywordIndexService;

  constructor(
    db: Database.Database,
    blobs: BlobStore,
    idempotency: IdempotencyRepository,
    documents: DocumentRepository,
    index: KeywordIndexService,
  ) {
    this.db = db;
    this.blobs = blobs;
    this.idempotency = idempotency;
    this.documents = documents;
    this.index = index;
  }

  async listAssets(filters: AssetFilters): Promise<{
    items: AssetSummaryV2[];
    total: number;
    groupCounts: {
      mp4: number;
      gif: number;
      image: number;
      markdownSources: number;
      documentSources: number;
      missingOccurrences: number;
    };
  }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.type !== undefined) {
      clauses.push("a.media_kind = ?");
      params.push(filters.type);
    }
    if (filters.q !== undefined && filters.q !== "") {
      clauses.push(
        "(LOWER(COALESCE(av.title, '')) LIKE ? OR LOWER(COALESCE(av.human_fields_json, '')) LIKE ?)",
      );
      const term = `%${filters.q.toLocaleLowerCase("zh-CN")}%`;
      params.push(term, term);
    }
    if (filters.merchant !== undefined && filters.merchant !== "") {
      clauses.push("json_extract(av.human_fields_json, '$.merchant') = ?");
      params.push(filters.merchant);
    }
    clauses.unshift("a.media_kind IN ('image', 'gif', 'video')");
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = z
      .array(AssetRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT a.id, a.media_kind, a.blob_hash, a.created_at, b.mime, b.bytes,
                    av.title, av.version, av.metadata_json, av.human_fields_json,
                    (SELECT COUNT(DISTINCT sv.source_id)
                       FROM canonical_occurrences o JOIN source_versions sv ON sv.id = o.source_version_id
                      WHERE o.asset_id = a.id) AS source_count,
                    (SELECT COUNT(*) FROM canonical_occurrences o WHERE o.asset_id = a.id) AS occurrence_count
             FROM assets a
             JOIN blobs b ON b.sha256 = a.blob_hash
             LEFT JOIN asset_versions av ON av.asset_id = a.id
               AND av.version = (SELECT MAX(v.version) FROM asset_versions v WHERE v.asset_id = a.id)
             ${where}
             ORDER BY a.created_at DESC, a.id DESC`,
          )
          .all(...params),
      );
    const mapped: AssetSummaryV2[] = [];
    for (const row of rows) {
      const summary = await this.toSummary(row);
      if (filters.state !== undefined && summary.availability !== filters.state) continue;
      mapped.push(summary);
    }
    const groupCounts = z
      .strictObject({
        mp4: z.int(),
        gif: z.int(),
        image: z.int(),
      })
      .parse(
        this.db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN media_kind = 'video' THEN 1 ELSE 0 END), 0) AS mp4,
               COALESCE(SUM(CASE WHEN media_kind = 'gif' THEN 1 ELSE 0 END), 0) AS gif,
               COALESCE(SUM(CASE WHEN media_kind = 'image' THEN 1 ELSE 0 END), 0) AS image
             FROM assets`,
          )
          .get(),
      );
    const markdownSources = CountRowSchema.parse(
      this.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE kind = 'local_markdown'").get(),
    ).count;
    const documentSources = CountRowSchema.parse(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM sources WHERE kind LIKE 'local_%' AND kind <> 'local_file'",
        )
        .get(),
    ).count;
    const missingOccurrences = CountRowSchema.parse(
      this.db.prepare("SELECT COUNT(*) AS count FROM canonical_occurrences WHERE media_status = 'missing'").get(),
    ).count;
    return {
      items: mapped.slice(filters.offset, filters.offset + filters.limit),
      total: mapped.length,
      groupCounts: {
        mp4: groupCounts.mp4,
        gif: groupCounts.gif,
        image: groupCounts.image,
        markdownSources,
        documentSources,
        missingOccurrences,
      },
    };
  }

  listSources(input: { kind?: string; limit: number; offset: number }): {
    items: SourceSummary[];
    total: number;
  } {
    const clauses = input.kind === undefined ? [] : ["s.kind = ?"];
    const params: unknown[] = input.kind === undefined ? [] : [input.kind];
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const total = CountRowSchema.parse(
      this.db.prepare(`SELECT COUNT(*) AS count FROM sources s ${where}`).get(...params),
    ).count;
    const rows = z
      .array(SourceRowSchema)
      .parse(
        this.db
          .prepare(
            `WITH current_versions AS (
               SELECT sv.*, ROW_NUMBER() OVER (
                 PARTITION BY sv.source_id ORDER BY sv.captured_at DESC, sv.id DESC
               ) AS position
               FROM source_versions sv
             )
             SELECT s.id, s.kind, s.title, s.status,
                    cv.id AS current_version_id,
                    COALESCE((
                      SELECT COUNT(*) FROM canonical_occurrences o
                      WHERE o.source_version_id = cv.id
                    ), 0) AS occurrence_count,
                    COALESCE((
                      SELECT COUNT(*) FROM canonical_occurrences o
                      WHERE o.source_version_id = cv.id AND o.media_status = 'missing'
                    ), 0) AS missing_occurrence_count,
                    COALESCE((
                      SELECT COUNT(DISTINCT o.asset_id) FROM canonical_occurrences o
                      WHERE o.source_version_id = cv.id AND o.asset_id IS NOT NULL
                    ), 0) AS linked_asset_count,
                    s.created_at, s.updated_at
             FROM sources s
             LEFT JOIN current_versions cv ON cv.source_id = s.id AND cv.position = 1
             ${where}
             ORDER BY s.created_at DESC, s.id DESC
             LIMIT ? OFFSET ?`,
          )
          .all(...params, input.limit, input.offset),
      );
    return {
      items: rows.map((row) =>
        SourceSummarySchema.parse({
          id: row.id,
          kind: row.kind,
          title: row.title,
          status: row.status,
          currentVersionId: row.current_version_id,
          occurrenceCount: row.occurrence_count,
          missingOccurrenceCount: row.missing_occurrence_count,
          linkedAssetCount: row.linked_asset_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      ),
      total,
    };
  }

  async getAssetDetail(id: string): Promise<AssetDetailV2> {
    const rowRaw = this.db
      .prepare(
        `SELECT a.id, a.media_kind, a.blob_hash, a.created_at, b.mime, b.bytes,
                av.title, av.version, av.metadata_json, av.human_fields_json,
                (SELECT COUNT(DISTINCT sv.source_id)
                   FROM canonical_occurrences o JOIN source_versions sv ON sv.id = o.source_version_id
                  WHERE o.asset_id = a.id) AS source_count,
                (SELECT COUNT(*) FROM canonical_occurrences o WHERE o.asset_id = a.id) AS occurrence_count
         FROM assets a
         JOIN blobs b ON b.sha256 = a.blob_hash
         LEFT JOIN asset_versions av ON av.asset_id = a.id
           AND av.version = (SELECT MAX(v.version) FROM asset_versions v WHERE v.asset_id = a.id)
         WHERE a.id = ?`,
      )
      .get(id);
    if (rowRaw === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "素材不存在" });
    }
    const row = AssetRowSchema.parse(rowRaw);
    const summary = await this.toSummary(row);
    const human = parseHumanFields(row.human_fields_json);
    const metadata = parseMetadata(row.metadata_json);
    const occurrences = this.occurrencesForAsset(id);
    return AssetDetailV2Schema.parse({
      summary,
      metadata,
      humanFields: {
        title: human.title === "" ? summary.title : human.title,
        tags: human.tags,
        origins: human.origins,
      },
      occurrences,
      sourceSuggestion: this.sourceSuggestionForAsset(id),
    });
  }

  patchAsset(
    id: string,
    body: PatchAssetRequest,
    context: WriteContext,
  ): {
    data: AssetPatchResult;
    requestId: string;
  } {
    const request = PatchAssetRequestSchema.parse(body);
    const requestHash = this.idempotency.requestHash({ id, request });
    const existing = this.idempotency.find(context.scope, context.key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError({
          statusCode: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "同一 Idempotency-Key 对应了不同请求",
        });
      }
      return z
        .strictObject({
          data: AssetPatchResultSchema,
          requestId: z.string(),
        })
        .parse(existing.response);
    }
    const title = request.title === undefined ? undefined : normalizeTitle(request.title);
    if (title !== undefined && (title === "" || [...title].length > 200)) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "标题不能为空且最多 200 个字符",
      });
    }
    let tags: { display: string[]; keys: string[] } | undefined;
    if (request.tags !== undefined) {
      try {
        tags = normalizeTags(request.tags);
      } catch (error) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: error instanceof Error ? error.message : "标签不合法",
        });
      }
    }
    const response = this.db.transaction(() => {
      const latest = this.db
        .prepare(
          `SELECT id, title, version, metadata_json, human_fields_json
           FROM asset_versions WHERE asset_id = ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(id);
      if (latest === undefined) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "素材不存在" });
      }
      const current = z
        .strictObject({
          id: z.uuid(),
          title: z.string(),
          version: z.int().nonnegative(),
          metadata_json: z.string(),
          human_fields_json: z.string(),
        })
        .parse(latest);
      if (current.version !== request.expectedVersion) {
        const human = parseHumanFields(current.human_fields_json);
        throw new ApiError({
          statusCode: 409,
          code: "ASSET_VERSION_CONFLICT",
          message: "素材已被修改，请刷新后重试",
          details: {
            currentVersion: current.version,
            current: {
              title: current.title,
              tags: human.tags,
              origins: human.origins,
            },
          },
        });
      }
      const human = parseHumanFields(current.human_fields_json);
      const nextTitle = title ?? current.title;
      const nextTags = tags?.display ?? human.tags;
      const origins = {
        title: title === undefined ? human.origins.title : ("manual" as const),
        tags: tags === undefined ? human.origins.tags : ("manual" as const),
      };
      const nextVersion = current.version + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO asset_versions
            (id, asset_id, title, metadata_json, human_fields_json, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          id,
          nextTitle,
          current.metadata_json,
          JSON.stringify({ title: nextTitle, tags: nextTags, origins, merchant: human.merchant }),
          nextVersion,
          now,
        );
      if (tags !== undefined) {
        this.db.prepare("DELETE FROM asset_tags WHERE asset_id = ?").run(id);
        const insertTag = this.db.prepare(
          "INSERT INTO tags(id, name, normalized_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(normalized_name) DO NOTHING",
        );
        const findTag = this.db.prepare("SELECT id FROM tags WHERE normalized_name = ?");
        const link = this.db.prepare(
          "INSERT INTO asset_tags(asset_id, tag_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        );
        for (let index = 0; index < tags.display.length; index += 1) {
          const display = tags.display[index];
          const key = tags.keys[index];
          if (display === undefined || key === undefined) continue;
          insertTag.run(randomUUID(), display, key, now);
          const tag = z.strictObject({ id: z.uuid() }).parse(findTag.get(key));
          link.run(id, tag.id, now);
        }
      }
      this.db.prepare("UPDATE assets SET updated_at = ? WHERE id = ?").run(now, id);
      this.index.rebuild();
      const responseData = {
        id,
        version: nextVersion,
        title: nextTitle,
        tags: nextTags,
        origins,
      };
      const envelope = { data: responseData, requestId: context.requestId };
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 200,
        requestId: context.requestId,
        response: envelope,
        resultRef: id,
      });
      return responseData;
    })();
    return { data: response, requestId: context.requestId };
  }

  getSourceContext(sourceId: string, versionId?: string): SourceContext {
    const source = z
      .strictObject({
        id: z.uuid(),
        kind: z.string(),
        title: z.string(),
        canonical_key: z.string(),
        original_uri: z.string().nullable(),
        status: z.enum(["active", "archived"]),
        created_at: UtcTimeSchema,
        updated_at: UtcTimeSchema,
      })
      .parse(this.db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId));
    const versionRaw =
      versionId === undefined
        ? this.db
            .prepare(
              "SELECT id, source_id, fingerprint, snapshot_blob_hash, captured_at FROM source_versions WHERE source_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
            )
            .get(sourceId)
        : this.db
            .prepare(
              "SELECT id, source_id, fingerprint, snapshot_blob_hash, captured_at FROM source_versions WHERE source_id = ? AND id = ?",
            )
            .get(sourceId, versionId);
    if (versionRaw === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "来源版本不存在" });
    }
    const version = z
      .strictObject({
        id: z.uuid(),
        source_id: z.uuid(),
        fingerprint: z.string(),
        snapshot_blob_hash: z.string(),
        captured_at: UtcTimeSchema,
      })
      .parse(versionRaw);
    return SourceContextSchema.parse({
      source: {
        id: source.id,
        kind: source.kind,
        title: source.title,
        canonicalKey: source.canonical_key,
        originalUri: source.original_uri,
        status: source.status,
      },
      version: {
        id: version.id,
        sourceId: version.source_id,
        fingerprint: version.fingerprint,
        snapshotBlobHash: version.snapshot_blob_hash,
        capturedAt: version.captured_at,
        fileUrl: `/api/v1/files/${version.snapshot_blob_hash}`,
      },
      document: this.documents.getSourceDocument(version.id),
      occurrences: this.occurrencesForVersion(version.id),
    });
  }

  private async toSummary(row: z.infer<typeof AssetRowSchema>): Promise<AssetSummaryV2> {
    if (
      row.media_kind !== "image" &&
      row.media_kind !== "gif" &&
      row.media_kind !== "video"
    ) {
      throw new ApiError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "素材类型不是本地媒体",
      });
    }
    const human = parseHumanFields(row.human_fields_json);
    const metadata = parseMetadata(row.metadata_json);
    const originalExists = await this.blobs.describe(row.blob_hash);
    const derivativeRows = z
      .array(z.strictObject({ kind: z.string(), blob_hash: z.string() }))
      .parse(
        this.db
          .prepare(
            `SELECT kind, blob_hash FROM derivatives
             WHERE asset_id = ? AND status = 'ready'
             ORDER BY created_at DESC, id DESC`,
          )
          .all(row.id),
      );
    let posterHash: string | null = null;
    let previewHash: string | null = null;
    for (const derivative of derivativeRows) {
      if (await this.blobs.describe(derivative.blob_hash)) {
        if (derivative.kind === "poster" && posterHash === null) posterHash = derivative.blob_hash;
        if (derivative.kind === "video_preview" && previewHash === null) previewHash = derivative.blob_hash;
      }
    }
    if (posterHash === null && (row.media_kind === "image" || row.media_kind === "gif")) {
      posterHash = row.blob_hash;
    }
    const hasPoster = posterHash !== null;
    const hasPreview = row.media_kind === "video" ? previewHash !== null : true;
    const occurrenceSource = z
      .strictObject({ count: z.int().nonnegative() })
      .parse(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM canonical_occurrences WHERE asset_id = ? AND source_version_id IN (SELECT id FROM source_versions)",
          )
          .get(row.id),
      ).count;
    const availability: AssetAvailability =
      originalExists !== null && hasPoster && hasPreview && occurrenceSource > 0
        ? "available"
        : "missing";
    const probe = metadata.probe;
    return AssetSummaryV2Schema.parse({
      id: row.id,
      mediaKind: row.media_kind,
      title: human.title === "" ? (row.title ?? "未命名素材") : human.title,
      tags: human.tags,
      origins: human.origins,
      version: row.version ?? 0,
      mime: row.mime,
      bytes: row.bytes,
      availability,
      previewFileUrl:
        row.media_kind === "video"
          ? previewHash === null
            ? null
            : `/api/v1/files/${previewHash}`
          : posterHash === null
            ? null
            : `/api/v1/files/${posterHash}`,
      posterFileUrl: posterHash === null ? null : `/api/v1/files/${posterHash}`,
      originalFileUrl: `/api/v1/files/${row.blob_hash}`,
      durationMs: probe !== null && "durationMs" in probe ? probe.durationMs : null,
      width: probe === null ? null : probe.width,
      height: probe === null ? null : probe.height,
      merchant: human.merchant,
      sourceCount: row.source_count,
      occurrenceCount: row.occurrence_count,
      createdAt: row.created_at,
    });
  }

  private sourceSuggestionForAsset(assetId: string): AssetSourceSuggestion | null {
    const rows = z
      .array(
        z.strictObject({
          map_index: z.int().min(0).max(2),
          table_index: z.int().nonnegative(),
          row_index: z.int().nonnegative(),
          section_heading: z.string(),
          file_cell: z.string(),
          title_text: z.string().nullable(),
          usage_markdown: z.string(),
          usage_text: z.string(),
          line_start: z.int().positive(),
          line_end: z.int().positive(),
          source_id: z.uuid(),
          source_version_id: z.uuid(),
          source_title: z.string(),
          source_relative_path: z.string(),
        }),
      )
      .parse(
        this.db
          .prepare(
            `SELECT e.map_index, e.table_index, e.row_index, e.section_heading, e.file_cell,
                    e.title_text, e.usage_markdown, e.usage_text, e.line_start, e.line_end,
                    sv.source_id, sv.id AS source_version_id, s.title AS source_title,
                    si.relative_path AS source_relative_path
             FROM asset_map_entries e
             JOIN source_versions sv ON sv.id = e.mapping_source_version_id
             JOIN sources s ON s.id = sv.source_id
             JOIN scan_items si ON si.id = e.mapping_scan_item_id
             WHERE e.asset_id = ?
               AND e.import_job_id = (
                 SELECT e2.import_job_id
                 FROM asset_map_entries e2
                 JOIN jobs j2 ON j2.id = e2.import_job_id
                 WHERE e2.asset_id = ?
                 ORDER BY j2.created_at DESC, j2.id DESC
                 LIMIT 1
               )
             ORDER BY e.map_index ASC, e.table_index ASC, e.row_index ASC, e.id ASC`,
          )
          .all(assetId, assetId),
      );
    const first = rows[0];
    if (first === undefined) return null;
    return AssetSourceSuggestionSchema.parse({
      origin: "source",
      parserVersion: "dcw-asset-map/1",
      title: first.title_text,
      usageMarkdown: first.usage_markdown,
      usageText: first.usage_text,
      ignoredSuggestionCount: rows.length - 1,
      provenance: {
        sourceId: first.source_id,
        sourceVersionId: first.source_version_id,
        sourceTitle: first.source_title,
        sourceRelativePath: first.source_relative_path,
        sectionHeading: first.section_heading,
        tableIndex: first.table_index,
        rowIndex: first.row_index,
        lineStart: first.line_start,
        lineEnd: first.line_end,
        fileCell: first.file_cell,
        mapIndex: first.map_index,
      },
    });
  }

  private occurrencesForAsset(assetId: string) {
    const rows = z
      .array(OccurrenceRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT o.id, o.source_version_id, sv.source_id, s.title AS source_title,
                    sv.source_relative_path,
                    o.locator_json, o.heading_path, o.before_text, o.after_text,
                    o.media_status, o.media_error_code
             FROM canonical_occurrences o
             JOIN source_versions sv ON sv.id = o.source_version_id
             JOIN sources s ON s.id = sv.source_id
             WHERE o.asset_id = ? ORDER BY o.created_at ASC, o.id ASC`,
          )
          .all(assetId),
      );
    return rows.map(occurrenceView);
  }

  private occurrencesForVersion(sourceVersionId: string) {
    const rows = z
      .array(OccurrenceRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT o.id, o.source_version_id, sv.source_id, s.title AS source_title,
                    sv.source_relative_path,
                    o.locator_json, o.heading_path, o.before_text, o.after_text,
                    o.media_status, o.media_error_code
             FROM canonical_occurrences o
             JOIN source_versions sv ON sv.id = o.source_version_id
             JOIN sources s ON s.id = sv.source_id
             WHERE o.source_version_id = ? ORDER BY o.occurrence_index ASC, o.id ASC`,
          )
          .all(sourceVersionId),
      );
    return rows.map(occurrenceView);
  }
}

function occurrenceView(row: z.infer<typeof OccurrenceRowSchema>) {
  const locator = OccurrenceLocatorSchema.parse(JSON.parse(row.locator_json));
  const sourceRelativePath =
    locator.kind === "local_file"
      ? locator.relativePath
      : locator.kind === "markdown"
        ? locator.normalizedRelativePath
        : "";
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    sourceTitle: row.source_title,
    sourceRelativePath: row.source_relative_path ?? sourceRelativePath,
    locator,
    headingPath: row.heading_path,
    beforeText: row.before_text,
    afterText: row.after_text,
    mediaStatus: row.media_status,
    errorCode: row.media_error_code,
  };
}

function parseHumanFields(value: string | null): z.infer<typeof HumanFieldsSchema> {
  if (value === null) return HumanFieldsSchema.parse({});
  try {
    return HumanFieldsSchema.parse(JSON.parse(value));
  } catch {
    return HumanFieldsSchema.parse({});
  }
}

function parseMetadata(value: string | null): z.infer<typeof AssetMetadataSchema> {
  if (value === null) {
    return {
      magicMime: "application/octet-stream",
      extensionMismatch: false,
      processorVersions: {},
      probe: null,
    };
  }
  return AssetMetadataSchema.parse(JSON.parse(value));
}
