import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AstSchema,
  ExportMediaSummarySchema,
  OutputMediaPlanItemSchema,
  type Ast,
  type Block,
  type ExportMediaSummary,
  type OutputMediaPlanItem,
} from "@dmall/contracts";
import { ApiError } from "../errors.js";

const RevisionRowSchema = z.strictObject({
  id: z.uuid(),
  rendition_id: z.uuid(),
  template_version_id: z.uuid().nullable(),
  ast_json: z.string(),
});

const AssetRowSchema = z.strictObject({
  asset_id: z.uuid(),
  media_kind: z.string(),
  asset_version_id: z.uuid(),
  blob_hash: z.string(),
  mime: z.string(),
  bytes: z.int().nonnegative(),
  relative_path: z.string(),
});

const DerivativeRowSchema = z.strictObject({
  derivative_id: z.uuid(),
  asset_id: z.uuid(),
  kind: z.string(),
  blob_hash: z.string(),
  mime: z.string(),
  bytes: z.int().nonnegative(),
  relative_path: z.string(),
});

const OccurrenceRowSchema = z.strictObject({
  occurrence_id: z.uuid(),
  asset_id: z.uuid().nullable(),
  media_status: z.string(),
});

const SegmentRowSchema = z.strictObject({
  segment_id: z.uuid(),
  asset_id: z.uuid(),
  start_ms: z.int().nonnegative(),
  end_ms: z.int().nonnegative(),
  derivative_id: z.uuid().nullable(),
});

export interface RevisionOutputSource {
  revisionId: string;
  renditionId: string;
  templateVersionId: string | null;
  ast: Ast;
}

export function loadRevisionOutputSource(db: Database.Database, revisionId: string): RevisionOutputSource {
  const row = db
    .prepare("SELECT id, rendition_id, template_version_id, ast_json FROM revisions WHERE id = ?")
    .get(revisionId);
  if (row === undefined) {
    throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "修订版本不存在" });
  }
  const parsed = RevisionRowSchema.parse(row);
  return {
    revisionId: parsed.id,
    renditionId: parsed.rendition_id,
    templateVersionId: parsed.template_version_id,
    ast: AstSchema.parse(JSON.parse(parsed.ast_json) as unknown),
  };
}

function extensionFor(mime: string, fallback: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  return map[mime] ?? fallback;
}

function mediaKindOf(mediaKind: string, mime: string): "image" | "gif" | "video" | "other" {
  if (mediaKind === "gif" || mime === "image/gif") return "gif";
  if (mediaKind === "video" || mime.startsWith("video/")) return "video";
  if (mediaKind === "image" || mime.startsWith("image/")) return "image";
  return "other";
}

export class OutputMediaPlanner {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  plan(ast: Ast, options?: { allowMissing?: boolean }): {
    items: OutputMediaPlanItem[];
    byKey: Map<string, OutputMediaPlanItem>;
    summary: ExportMediaSummary;
    warnings: Array<{ code: string; message: string }>;
  } {
    const byKey = new Map<string, OutputMediaPlanItem>();
    const missing: ExportMediaSummary["missing"] = [];
    const degraded: ExportMediaSummary["degraded"] = [];
    const warnings: Array<{ code: string; message: string }> = [];
    const blocks = ast.kind === "feishu_doc"
      ? ast.sections.flatMap((section) => section.blocks)
      : ast.slides.flatMap((slide) => slide.blocks);
    for (const block of blocks) {
      if (block.type === "image") {
        const key = block.derivativeId === null
          ? `asset_version:${block.assetVersionId}`
          : `derivative:${block.derivativeId}`;
        if (byKey.has(key)) continue;
        const item = this.assetVersion(block, key, block.derivativeId);
        if (item === null) {
          missing.push({ nodeId: block.id, message: "图片引用缺失或素材不可用" });
          continue;
        }
        const occurrence = this.occurrence(block.occurrenceId);
        if (occurrence === null || occurrence.media_status !== "available") {
          missing.push({ nodeId: block.id, message: "图片出现位置缺失或媒体状态不可用" });
          continue;
        }
        if (occurrence.asset_id !== null && occurrence.asset_id !== item.assetId) {
          missing.push({ nodeId: block.id, message: "图片出现位置与素材版本不匹配" });
          continue;
        }
        byKey.set(key, OutputMediaPlanItemSchema.parse({ ...item, occurrenceId: block.occurrenceId }));
        if (item.mediaKind === "gif") {
          degraded.push({
            nodeId: block.id,
            kind: "gif",
            message: "GIF 在 PDF/飞书中会静态化为首帧",
          });
        }
      } else if (block.type === "video") {
        const posterKey = `derivative:${block.posterDerivativeId}`;
        const poster = this.derivative(block.posterDerivativeId);
        const video = this.assetVersionOnly(block.assetVersionId);
        if (poster === null) {
          missing.push({ nodeId: block.id, message: "视频封面帧缺失" });
          continue;
        }
        if (video === null) {
          missing.push({ nodeId: block.id, message: "视频素材版本缺失" });
          continue;
        }
        if (poster.assetId !== video.assetId) {
          missing.push({ nodeId: block.id, message: "视频封面帧与视频素材不匹配" });
          continue;
        }
        let startMs: number | null = null;
        let endMs: number | null = null;
        if (block.segmentId !== null) {
          const segment = this.segment(block.segmentId);
          if (segment === null || segment.asset_id !== video.assetId) {
            missing.push({ nodeId: block.id, message: "视频片段引用缺失或不匹配" });
            continue;
          }
          startMs = segment.start_ms;
          endMs = segment.end_ms;
        }
        if (!byKey.has(posterKey)) {
          byKey.set(posterKey, OutputMediaPlanItemSchema.parse({
            ...poster,
            key: posterKey,
            role: "poster",
            occurrenceId: null,
            segmentId: block.segmentId,
            startMs,
            endMs,
          }));
        }
        const videoKey = `asset_version:${block.assetVersionId}`;
        if (!byKey.has(videoKey)) {
          byKey.set(videoKey, OutputMediaPlanItemSchema.parse({
            ...video,
            key: videoKey,
            role: "video",
            occurrenceId: null,
            segmentId: block.segmentId,
            startMs,
            endMs,
          }));
        }
        degraded.push({
          nodeId: block.id,
          kind: "video",
          message: "视频在 PDF/飞书中静态化为封面帧；HTML 中可点击播放",
        });
      } else if (block.type === "readonly_source_block" && block.previewDerivativeId !== null) {
        const key = `derivative:${block.previewDerivativeId}`;
        if (byKey.has(key)) continue;
        const preview = this.derivative(block.previewDerivativeId);
        if (preview === null) {
          missing.push({ nodeId: block.id, message: "只读来源预览图缺失" });
          continue;
        }
        byKey.set(key, OutputMediaPlanItemSchema.parse({
          ...preview,
          key,
          role: "source_preview",
          occurrenceId: null,
          segmentId: null,
          startMs: null,
          endMs: null,
        }));
        warnings.push({
          code: "READONLY_SOURCE_IMAGE",
          message: `只读来源块 ${block.id} 以静态预览输出`,
        });
      }
    }
    if (missing.length > 0 && options?.allowMissing !== true) {
      throw new ApiError({
        statusCode: 422,
        code: "EXPORT_MEDIA_MISSING",
        message: "导出引用的关键媒体缺失或不匹配，已阻止输出",
        details: { missing },
      });
    }
    const items = [...byKey.values()];
    return {
      items,
      byKey,
      summary: ExportMediaSummarySchema.parse({
        total: items.length,
        images: items.filter((item) => item.mediaKind === "image").length,
        gifs: items.filter((item) => item.mediaKind === "gif").length,
        videos: items.filter((item) => item.mediaKind === "video").length,
        missing,
        degraded,
      }),
      warnings,
    };
  }

  private assetVersion(
    block: Extract<Block, { type: "image" }>,
    key: string,
    derivativeId: string | null,
  ): OutputMediaPlanItem | null {
    if (derivativeId !== null) {
      const derivative = this.derivative(derivativeId);
      if (derivative === null) return null;
      const asset = this.assetVersionOnly(block.assetVersionId);
      if (asset === null || asset.assetId !== derivative.assetId) return null;
      return OutputMediaPlanItemSchema.parse({
        ...derivative,
        key,
        role: "image",
        assetVersionId: block.assetVersionId,
        occurrenceId: block.occurrenceId,
        segmentId: null,
        startMs: null,
        endMs: null,
      });
    }
    const asset = this.assetVersionOnly(block.assetVersionId);
    return asset === null ? null : OutputMediaPlanItemSchema.parse({ ...asset, key });
  }

  private assetVersionOnly(assetVersionId: string): Omit<OutputMediaPlanItem, "key"> | null {
    const row = this.db.prepare(
      `SELECT av.id AS asset_version_id, a.id AS asset_id, a.media_kind,
              a.blob_hash, b.mime, b.bytes, b.relative_path
       FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
       JOIN blobs b ON b.sha256 = a.blob_hash
       WHERE av.id = ?`,
    ).get(assetVersionId);
    if (row === undefined) return null;
    const parsed = AssetRowSchema.parse(row);
    const mediaKind = mediaKindOf(parsed.media_kind, parsed.mime);
    const ext = extensionFor(parsed.mime, mediaKind === "video" ? "mp4" : "bin");
    return {
      role: mediaKind === "video" ? "video" : "image",
      mediaKind,
      assetVersionId: parsed.asset_version_id,
      assetId: parsed.asset_id,
      derivativeId: null,
      occurrenceId: null,
      segmentId: null,
      blobHash: parsed.blob_hash,
      relativePath: parsed.relative_path,
      mime: parsed.mime,
      bytes: parsed.bytes,
      originalName: `asset-${parsed.asset_version_id.slice(0, 8)}.${ext}`,
      startMs: null,
      endMs: null,
    };
  }

  private derivative(derivativeId: string): Omit<OutputMediaPlanItem, "key"> | null {
    const row = this.db.prepare(
      `SELECT d.id AS derivative_id, d.asset_id, d.kind, d.blob_hash, b.mime, b.bytes, b.relative_path
       FROM derivatives d JOIN blobs b ON b.sha256 = d.blob_hash WHERE d.id = ?`,
    ).get(derivativeId);
    if (row === undefined) return null;
    const parsed = DerivativeRowSchema.parse(row);
    const mediaKind = mediaKindOf(parsed.kind, parsed.mime);
    const ext = extensionFor(parsed.mime, mediaKind === "video" ? "mp4" : "png");
    return {
      role: "image",
      mediaKind,
      assetVersionId: null,
      assetId: parsed.asset_id,
      derivativeId: parsed.derivative_id,
      occurrenceId: null,
      segmentId: null,
      blobHash: parsed.blob_hash,
      relativePath: parsed.relative_path,
      mime: parsed.mime,
      bytes: parsed.bytes,
      originalName: `derivative-${parsed.derivative_id.slice(0, 8)}.${ext}`,
      startMs: null,
      endMs: null,
    };
  }

  private occurrence(id: string): z.infer<typeof OccurrenceRowSchema> | null {
    const row = this.db.prepare(
      "SELECT id AS occurrence_id, asset_id, media_status FROM occurrences WHERE id = ?",
    ).get(id);
    return row === undefined ? null : OccurrenceRowSchema.parse(row);
  }

  private segment(id: string): z.infer<typeof SegmentRowSchema> | null {
    const row = this.db.prepare(
      "SELECT id AS segment_id, asset_id, start_ms, end_ms, derivative_id FROM segments WHERE id = ?",
    ).get(id);
    return row === undefined ? null : SegmentRowSchema.parse(row);
  }
}
