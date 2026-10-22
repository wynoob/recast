import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { BlobStore } from "@dmall/storage";
import { z } from "zod";
import {
  LocatorSchema,
  type DocumentChunkDraft,
  type HardFilters,
  type Locator,
} from "@dmall/contracts";
import {
  CHUNK_SEARCH_TABLE,
  ChunkSearchRowSchema,
  ensureChunkSearchSchema,
  replaceChunkSearchRows,
  searchKeywordOnly,
  RrfOutcomeSchema,
  type ChunkSearchRow,
  type RrfOutcome,
} from "@dmall/search";
import { ApiError } from "../errors.js";

const GenerationRowSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(["building", "active", "superseded", "failed"]),
  chunk_count: z.int().nonnegative(),
});

const DocumentChunkRowSchema = z.strictObject({
  id: z.uuid(),
  source_version_id: z.uuid(),
  section_id: z.uuid(),
  text: z.string(),
  locator_json: z.string(),
  block_ids_json: z.string(),
  locators_json: z.string(),
  metadata_json: z.string(),
  chunk_kind: z.string(),
});

const AssetChunkSourceSchema = z.strictObject({
  asset_id: z.uuid(),
  source_version_id: z.uuid(),
  occurrence_id: z.uuid(),
  locator_json: z.string(),
  media_status: z.enum(["discovered", "available", "missing", "unsupported"]),
  media_kind: z.enum(["image", "gif", "video"]),
  title: z.string(),
  tags_json: z.string(),
  human_fields_json: z.string(),
});

const FactChunkSourceSchema = z.strictObject({
  fact_id: z.uuid(),
  fact_version_id: z.uuid(),
  source_version_id: z.uuid(),
  source_locator_json: z.string(),
  period_json: z.string().nullable(),
  index_text: z.string(),
  status: z.enum(["unverified", "confirmed", "obsolete"]),
  merchant_id: z.string().nullable(),
});

const AvailabilityRowSchema = z.strictObject({
  chunk_id: z.uuid(),
  availability: ChunkSearchRowSchema.shape.availability,
  snapshot_blob_hash: z.string(),
  occurrence_id: z.uuid().nullable(),
  media_status: z.enum(["discovered", "available", "missing", "unsupported"]).nullable(),
  asset_id: z.uuid().nullable(),
  blob_hash: z.string().nullable(),
  media_kind: z.enum(["image", "gif", "video"]).nullable(),
});

export class KeywordIndexService {
  private readonly db: Database.Database;

  constructor(db: Database.Database, private readonly blobs: BlobStore) {
    this.db = db;
    ensureChunkSearchSchema(db);
    this.ensureActiveGeneration();
  }

  activeGenerationId(): string {
    const row = this.activeRow();
    if (row === null) {
      throw new ApiError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "关键词索引没有活动代次",
      });
    }
    return row.id;
  }

  search(query: string, filters: HardFilters, limit: number): RrfOutcome {
    this.refreshAvailability();
    const outcome = searchKeywordOnly(
      this.db,
      query,
      filters,
      "embedding 未配置，当前仅执行本地 FTS5 关键词检索",
    );
    return RrfOutcomeSchema.parse({
      ...outcome,
      hits: outcome.hits.slice(0, limit),
    });
  }

  insertDocumentChunks(input: {
    sourceVersionId: string;
    drafts: readonly DocumentChunkDraft[];
    sectionIdByAdapter: ReadonlyMap<string, string>;
    blockIdByAdapter: ReadonlyMap<string, string>;
    blockLocatorById: ReadonlyMap<string, Locator>;
    sectionLocatorById: ReadonlyMap<string, Locator>;
    now: string;
  }): void {
    const insert = this.db.prepare(
      `INSERT INTO chunks(
        id, source_version_id, occurrence_id, text, kind, locator_json, content_hash,
        created_at, section_id, block_ids_json, locators_json, metadata_json,
        chunk_kind, ref_type, fact_version_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chunk', NULL)
      ON CONFLICT(id) DO NOTHING`,
    );
    for (const draft of input.drafts) {
      const sectionId = input.sectionIdByAdapter.get(draft.sectionAdapterId);
      if (sectionId === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: `chunk 引用未知章节 ${draft.sectionAdapterId}`,
        });
      }
      const blockIds: string[] = [];
      const locators: Locator[] = [];
      for (const adapterId of draft.blockAdapterIds) {
        const blockId = input.blockIdByAdapter.get(adapterId);
        const locator = input.blockLocatorById.get(adapterId);
        if (blockId === undefined || locator === undefined) {
          throw new ApiError({
            statusCode: 422,
            code: "VALIDATION_ERROR",
            message: `chunk 引用未知正文块 ${adapterId}`,
          });
        }
        blockIds.push(blockId);
        locators.push(locator);
      }
      if (locators.length === 0) {
        const sectionLocator = input.sectionLocatorById.get(draft.sectionAdapterId);
        if (sectionLocator === undefined) {
          throw new ApiError({
            statusCode: 422,
            code: "VALIDATION_ERROR",
            message: "标题章节缺少可解析定位",
          });
        }
        locators.push(sectionLocator);
      }
      const existing = this.db.prepare(
        `SELECT id FROM chunks
         WHERE source_version_id = ? AND section_id = ? AND content_hash = ?
           AND json_extract(metadata_json, '$.locationKey') = ?
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).get(input.sourceVersionId, sectionId, draft.contentHash, draft.locationKey);
      const chunkId = existing === undefined
        ? draft.chunkId
        : z.strictObject({ id: z.uuid() }).parse(existing).id;
      const row = searchRow({
        chunkId,
        refType: "chunk",
        sourceVersionId: input.sourceVersionId,
        occurrenceId: null,
        title: draft.title,
        tags: draft.tags,
        text: draft.text,
        merchantId: draft.merchantId,
        mediaKind: draft.mediaKind,
        recordDate: draft.recordDate,
        effectiveFrom: draft.effectiveFrom,
        effectiveTo: draft.effectiveTo,
        audience: draft.audience,
        functions: draft.functions,
        obsolete: draft.obsolete,
        availability: draft.availability,
        locationKey: draft.locationKey,
      });
      insert.run(
        chunkId,
        input.sourceVersionId,
        draft.text,
        draft.chunkKind,
        JSON.stringify(locators[0]),
        draft.contentHash,
        input.now,
        sectionId,
        JSON.stringify(blockIds),
        JSON.stringify(locators),
        JSON.stringify(row),
        draft.chunkKind,
      );
    }
  }

  rebuild(): string {
    this.ensureActiveGeneration();
    const generationId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const candidates = this.collectRows(now);
      this.db
        .prepare(
          `INSERT INTO index_generations(id, status, chunk_count, created_at, activated_at)
           VALUES (?, 'building', ?, ?, NULL)`,
        )
        .run(generationId, candidates.length, now);
      const membership = this.db.prepare(
        `INSERT INTO index_generation_chunks(index_generation_id, chunk_id, created_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const row of candidates) {
        membership.run(generationId, row.chunkId, now);
      }
      this.db.prepare(`DELETE FROM ${CHUNK_SEARCH_TABLE}`).run();
      replaceChunkSearchRows(this.db, candidates);
      this.db
        .prepare(
          `UPDATE index_generations SET status = 'superseded', retired_at = ?
           WHERE status = 'active' AND id <> ?`,
        )
        .run(now, generationId);
      this.db
        .prepare(
          `UPDATE index_generations SET status = 'active', activated_at = ?, chunk_count = ?
           WHERE id = ?`,
        )
        .run(now, candidates.length, generationId);
    })();
    return generationId;
  }

  private refreshAvailability(): void {
    const rows = z.array(AvailabilityRowSchema).parse(
      this.db.prepare(
        `SELECT cs.chunk_id, cs.availability, sv.snapshot_blob_hash,
                c.occurrence_id, o.media_status, a.id AS asset_id,
                a.blob_hash, a.media_kind
         FROM chunk_search cs
         JOIN chunks c ON c.id = cs.chunk_id
         JOIN source_versions sv ON sv.id = c.source_version_id
         LEFT JOIN canonical_occurrences o ON o.id = c.occurrence_id
         LEFT JOIN assets a ON a.id = o.asset_id`,
      ).all(),
    );
    const present = new Map<string, boolean>();
    const hasBlob = (hash: string): boolean => {
      const cached = present.get(hash);
      if (cached !== undefined) return cached;
      let exists = false;
      try {
        exists = statSync(this.blobs.pathForHash(hash)).isFile();
      } catch {
        exists = false;
      }
      present.set(hash, exists);
      return exists;
    };
    this.db.transaction(() => {
      const update = this.db.prepare(
        "UPDATE chunk_search SET availability = ? WHERE chunk_id = ?",
      );
      for (const row of rows) {
        let availability: ChunkSearchRow["availability"];
        if (row.asset_id !== null && row.blob_hash !== null) {
          const derivatives = z.array(z.strictObject({ kind: z.string(), blob_hash: z.string() })).parse(
            this.db.prepare(
              "SELECT kind, blob_hash FROM derivatives WHERE asset_id = ? AND status = 'ready'",
            ).all(row.asset_id),
          );
          const hasPoster = row.media_kind !== "video" || derivatives.some(
            (derivative) => derivative.kind === "poster" && hasBlob(derivative.blob_hash),
          );
          const hasPreview = row.media_kind !== "video" || derivatives.some(
            (derivative) => derivative.kind === "video_preview" && hasBlob(derivative.blob_hash),
          );
          availability = hasBlob(row.blob_hash) && hasPoster && hasPreview ? "available" : "missing";
        } else if (row.occurrence_id !== null) {
          availability = row.media_status === "unsupported" ? "unsupported" : "missing";
        } else {
          availability = hasBlob(row.snapshot_blob_hash) ? "available" : "missing";
        }
        if (availability !== row.availability) update.run(availability, row.chunk_id);
      }
    })();
  }

  private collectRows(now: string): ChunkSearchRow[] {
    const rows: ChunkSearchRow[] = [];
    const documentRows = z
      .array(DocumentChunkRowSchema)
      .parse(
        this.db
          .prepare(
            `WITH latest_versions AS (
               SELECT sv.id
               FROM source_versions sv
               WHERE sv.id = (
                 SELECT sv2.id FROM source_versions sv2
                 WHERE sv2.source_id = sv.source_id
                 ORDER BY sv2.captured_at DESC, sv2.id DESC LIMIT 1
               )
             )
             SELECT c.id, c.source_version_id, c.section_id, c.text, c.locator_json,
                    c.block_ids_json, c.locators_json, c.metadata_json, c.chunk_kind
             FROM chunks c
             JOIN latest_versions lv ON lv.id = c.source_version_id
             WHERE c.ref_type = 'chunk' AND c.section_id IS NOT NULL
             ORDER BY c.source_version_id ASC, c.created_at ASC, c.id ASC`,
          )
          .all(),
      );
    for (const row of documentRows) {
      const parsed = ChunkSearchRowSchema.parse(JSON.parse(row.metadata_json));
      rows.push({ ...parsed, chunkId: row.id });
    }

    const assetRows = z
      .array(AssetChunkSourceSchema)
      .parse(
        this.db
          .prepare(
            `SELECT a.id AS asset_id, sv.id AS source_version_id, o.id AS occurrence_id,
                    o.locator_json, o.media_status, a.media_kind,
                    av.title, av.human_fields_json,
                    COALESCE((
                      SELECT json_group_array(t.name)
                      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                      WHERE at.asset_id = a.id
                    ), '[]') AS tags_json
             FROM assets a
             JOIN asset_versions av ON av.asset_id = a.id
               AND av.version = (SELECT MAX(v.version) FROM asset_versions v WHERE v.asset_id = a.id)
             JOIN canonical_occurrences o ON o.asset_id = a.id
             JOIN source_versions sv ON sv.id = o.source_version_id
             WHERE a.media_kind IN ('image', 'gif', 'video')
               AND sv.id = (
                 SELECT sv2.id FROM source_versions sv2
                 WHERE sv2.source_id = sv.source_id
                 ORDER BY sv2.captured_at DESC, sv2.id DESC LIMIT 1
               )
             ORDER BY a.id ASC, o.id ASC`,
          )
          .all(),
      );
    for (const asset of assetRows) {
      const tags = z.array(z.string()).parse(JSON.parse(asset.tags_json));
      const human = parseRecord(asset.human_fields_json);
      const merchantId = human !== null && typeof human["merchant"] === "string"
        ? z.uuid().safeParse(human["merchant"]).data ?? null
        : null;
      const locationKey = `asset:${asset.asset_id}:${asset.occurrence_id}`;
      const chunkId = uuidFor(`asset:${asset.asset_id}:${asset.title}:${tags.join("\u0000")}:${asset.occurrence_id}`);
      const body = [asset.title, ...tags].join("\n");
      const row = searchRow({
        chunkId,
        refType: "chunk",
        sourceVersionId: asset.source_version_id,
        occurrenceId: asset.occurrence_id,
        title: asset.title,
        tags,
        text: body,
        merchantId,
        mediaKind: asset.media_kind === "video" ? "video" : asset.media_kind,
        recordDate: null,
        effectiveFrom: null,
        effectiveTo: null,
        audience: [],
        functions: [],
        obsolete: false,
        availability:
          asset.media_status === "available"
            ? "available"
            : asset.media_status === "unsupported"
              ? "unsupported"
              : "missing",
        locationKey,
      });
      this.ensureChunkRecord({
        now,
        row,
        sourceVersionId: asset.source_version_id,
        occurrenceId: asset.occurrence_id,
        locator: LocatorSchema.parse(JSON.parse(asset.locator_json)),
        sectionId: null,
        factVersionId: null,
      });
      rows.push(row);
    }

    const factRows = z
      .array(FactChunkSourceSchema)
      .parse(
        this.db
          .prepare(
            `SELECT f.id AS fact_id, fv.id AS fact_version_id, fv.source_version_id,
                    fv.source_locator_json, fv.period_json, fv.index_text,
                    fv.status, fv.merchant_id
             FROM facts f
             JOIN fact_versions fv ON fv.id = f.current_version_id
             WHERE fv.source_version_id IS NOT NULL
               AND fv.index_text IS NOT NULL
             ORDER BY f.id ASC`,
          )
          .all(),
      );
    for (const fact of factRows) {
      const locator = LocatorSchema.parse(JSON.parse(fact.source_locator_json));
      const period = fact.period_json === null
        ? null
        : z
            .strictObject({ start: z.iso.date(), end: z.iso.date() })
            .parse(JSON.parse(fact.period_json));
      const chunkId = uuidFor(`fact:${fact.fact_version_id}:${fact.index_text}`);
      const row = searchRow({
        chunkId,
        refType: "fact",
        sourceVersionId: fact.source_version_id,
        occurrenceId: null,
        title: fact.index_text.slice(0, 200),
        tags: [],
        text: fact.index_text,
        merchantId: fact.merchant_id === null ? null : z.uuid().parse(fact.merchant_id),
        mediaKind: "document",
        recordDate: null,
        effectiveFrom: period?.start ?? null,
        effectiveTo: period?.end ?? null,
        audience: [],
        functions: [],
        obsolete: fact.status === "obsolete",
        availability: "available",
        locationKey: `fact:${fact.fact_id}:${fact.fact_version_id}`,
      });
      this.ensureChunkRecord({
        now,
        row,
        sourceVersionId: fact.source_version_id,
        occurrenceId: null,
        locator,
        sectionId: null,
        factVersionId: fact.fact_version_id,
      });
      rows.push(row);
    }
    return rows;
  }

  private ensureChunkRecord(input: {
    now: string;
    row: ChunkSearchRow;
    sourceVersionId: string;
    occurrenceId: string | null;
    locator: Locator;
    sectionId: string | null;
    factVersionId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chunks(
          id, source_version_id, occurrence_id, text, kind, locator_json, content_hash,
          created_at, section_id, block_ids_json, locators_json, metadata_json,
          chunk_kind, ref_type, fact_version_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.row.chunkId,
        input.sourceVersionId,
        input.occurrenceId,
        input.row.body,
        input.row.refType === "fact" ? "fact" : "metadata",
        JSON.stringify(input.locator),
        sha256(input.row.body),
        input.now,
        input.sectionId,
        JSON.stringify([input.locator]),
        JSON.stringify(input.row),
        input.row.refType === "fact" ? "fact" : "text",
        input.row.refType,
        input.factVersionId,
      );
  }

  private ensureActiveGeneration(): void {
    if (this.activeRow() !== null) return;
    const generationId = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO index_generations(id, status, chunk_count, created_at, activated_at)
         VALUES (?, 'active', 0, ?, ?)`,
      )
      .run(generationId, now, now);
  }

  private activeRow(): z.infer<typeof GenerationRowSchema> | null {
    const row = this.db
      .prepare(
        "SELECT id, status, chunk_count FROM index_generations WHERE status = 'active' ORDER BY activated_at DESC, id DESC LIMIT 1",
      )
      .get();
    return row === undefined ? null : GenerationRowSchema.parse(row);
  }
}

function searchRow(input: {
  chunkId: string;
  refType: "chunk" | "fact";
  sourceVersionId: string;
  occurrenceId: string | null;
  title: string;
  tags: string[];
  text: string;
  merchantId: string | null;
  mediaKind: "document" | "image" | "gif" | "video" | "audio";
  recordDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  audience: string[];
  functions: string[];
  obsolete: boolean;
  availability: "available" | "missing" | "unsupported";
  locationKey: string;
}): ChunkSearchRow {
  return ChunkSearchRowSchema.parse({
    chunkId: input.chunkId,
    refType: input.refType,
    sourceVersionId: input.sourceVersionId,
    occurrenceId: input.occurrenceId,
    locationKey: input.locationKey,
    availability: input.availability,
    mediaKind: input.mediaKind,
    merchantId: input.merchantId,
    recordDate: input.recordDate,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    obsolete: input.obsolete,
    audience: input.audience,
    functions: input.functions,
    title: input.title,
    tags: input.tags,
    body: input.text,
  });
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function uuidFor(value: string): string {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
