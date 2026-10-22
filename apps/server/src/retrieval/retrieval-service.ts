import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  LocatorSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SelectionViewSchema,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
  type SelectionView,
} from "@dmall/contracts";
import type { DocumentRepository } from "../documents/repository.js";
import { ApiError } from "../errors.js";
import type { FactService } from "../facts/fact-service.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { WriteContext } from "../import-service.js";
import type { KeywordIndexService } from "./index-service.js";

const ChunkRowSchema = z.strictObject({
  id: z.uuid(),
  source_version_id: z.uuid(),
  occurrence_id: z.uuid().nullable(),
  section_id: z.uuid().nullable(),
  block_ids_json: z.string(),
  locators_json: z.string(),
  ref_type: z.enum(["chunk", "fact"]),
  fact_version_id: z.uuid().nullable(),
  source_id: z.uuid(),
  source_title: z.string(),
  source_kind: z.string(),
  snapshot_blob_hash: z.string(),
});

const HandleRowSchema = z.strictObject({
  id: z.uuid(),
  index_generation_id: z.uuid(),
  ref_id: z.uuid(),
  ref_type: z.enum(["source_version", "fact"]),
  chunk_id: z.uuid(),
  source_id: z.uuid().nullable(),
  source_version_id: z.uuid().nullable(),
  occurrence_id: z.uuid().nullable(),
  section_id: z.uuid().nullable(),
  fact_id: z.uuid().nullable(),
  fact_version_id: z.uuid().nullable(),
  block_ids_json: z.string(),
  locators_json: z.string(),
  created_at: z.string(),
});

export class RetrievalService {
  private readonly db: Database.Database;
  private readonly index: KeywordIndexService;
  private readonly documents: DocumentRepository;
  private readonly facts: FactService;
  private readonly idempotency: IdempotencyRepository;

  constructor(input: {
    db: Database.Database;
    index: KeywordIndexService;
    documents: DocumentRepository;
    facts: FactService;
    idempotency: IdempotencyRepository;
  }) {
    this.db = input.db;
    this.index = input.index;
    this.documents = input.documents;
    this.facts = input.facts;
    this.idempotency = input.idempotency;
  }

  search(body: SearchRequest, context: WriteContext): SearchResponse {
    const request = SearchRequestSchema.parse(body);
    const requestHash = this.idempotency.requestHash(request);
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
        .strictObject({ data: SearchResponseSchema, requestId: z.string() })
        .parse(existing.response).data;
    }

    const generationId = this.index.activeGenerationId();
    const outcome = this.index.search(request.query, request.filters, request.limit);
    const response = this.db.transaction(() => {
      const hits = outcome.hits.map((hit) => this.createHit(generationId, hit));
      const value = SearchResponseSchema.parse({
        schemaVersion: 1,
        indexGenerationId: generationId,
        capabilities: {
          keyword: "available",
          semantic: "unavailable",
          mode: "keyword_only",
          message: "embedding 未配置；当前结果来自本地 FTS5 关键词检索，RRF 分数不是概率",
        },
        filters: request.filters,
        hits,
        total: hits.length,
      });
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 200,
        requestId: context.requestId,
        response: { data: value, requestId: context.requestId },
        resultRef: generationId,
      });
      return value;
    })();
    return response;
  }

  getSelection(handleId: string): SelectionView {
    const databaseHandleId = decodeSelectionHandle(handleId);
    const raw = this.db
      .prepare("SELECT * FROM selection_handles WHERE id = ?")
      .get(databaseHandleId);
    if (raw === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "检索选择不存在" });
    }
    const handle = HandleRowSchema.parse(raw);
    const activeGenerationId = this.index.activeGenerationId();
    if (handle.index_generation_id !== activeGenerationId) {
      throw new ApiError({
        statusCode: 409,
        code: "SEARCH_SELECTION_STALE",
        message: "检索索引已切换，该选择引用的是旧代次",
        details: {
          selectionGenerationId: handle.index_generation_id,
          activeGenerationId,
        },
      });
    }
    const blockIds = z.array(z.uuid()).parse(JSON.parse(handle.block_ids_json));
    const locators = z
      .array(LocatorSchema)
      .parse(JSON.parse(handle.locators_json));
    const section = handle.section_id === null ? null : this.documents.getSection(handle.section_id);
    const blocks = this.documents.blocksByIds(blockIds);
    if (handle.ref_type === "fact") {
      if (handle.fact_id === null) {
        throw new ApiError({ statusCode: 500, code: "INTERNAL_ERROR", message: "事实选择缺少实体" });
      }
      const fact = this.facts.requireFact(handle.fact_id);
    return SelectionViewSchema.parse({
        id: encodeSelectionHandle({
          handleId: handle.id,
          indexGenerationId: handle.index_generation_id,
          refType: handle.ref_type,
          refId: handle.ref_id,
        }),
        indexGenerationId: handle.index_generation_id,
        refId: handle.ref_id,
        refType: "fact",
        chunkId: handle.chunk_id,
        sourceId: handle.source_id,
        sourceVersionId: handle.source_version_id,
        sourceTitle: null,
        occurrenceId: null,
        section: null,
        blocks: [],
        locators,
        fact,
        sourceFileUrl:
          handle.source_version_id === null
            ? null
            : this.sourceFileUrl(handle.source_version_id),
        sourceDocumentUrl:
          handle.source_id === null || handle.source_version_id === null
            ? null
            : `/api/v1/sources/${handle.source_id}?versionId=${handle.source_version_id}`,
      });
    }
    return SelectionViewSchema.parse({
      id: encodeSelectionHandle({
        handleId: handle.id,
        indexGenerationId: handle.index_generation_id,
        refType: handle.ref_type,
        refId: handle.ref_id,
      }),
      indexGenerationId: handle.index_generation_id,
      refId: handle.ref_id,
      refType: "source_version",
      chunkId: handle.chunk_id,
      sourceId: handle.source_id,
      sourceVersionId: handle.source_version_id,
      sourceTitle: this.sourceTitle(handle.source_version_id),
      occurrenceId: handle.occurrence_id,
      section,
      blocks,
      locators,
      fact: null,
      sourceFileUrl:
        handle.source_version_id === null
          ? null
          : this.sourceFileUrl(handle.source_version_id),
      sourceDocumentUrl:
        handle.source_id === null || handle.source_version_id === null
          ? null
          : `/api/v1/sources/${handle.source_id}?versionId=${handle.source_version_id}`,
    });
  }

  private createHit(
    generationId: string,
    hit: ReturnType<KeywordIndexService["search"]>["hits"][number],
  ): SearchHit {
    const row = ChunkRowSchema.parse(
      this.db
        .prepare(
          `SELECT c.id, c.source_version_id, c.occurrence_id, c.section_id,
                  c.block_ids_json, c.locators_json, c.ref_type, c.fact_version_id,
                  sv.source_id, s.title AS source_title, s.kind AS source_kind,
                  sv.snapshot_blob_hash
           FROM chunks c
           JOIN source_versions sv ON sv.id = c.source_version_id
           JOIN sources s ON s.id = sv.source_id
           WHERE c.id = ?`,
        )
        .get(hit.refId),
    );
    const factId = row.fact_version_id === null
      ? null
      : z
          .strictObject({ fact_id: z.uuid() })
          .parse(
            this.db
              .prepare("SELECT fact_id FROM fact_versions WHERE id = ?")
              .get(row.fact_version_id),
          ).fact_id;
    const blockIds = z.array(z.uuid()).parse(JSON.parse(row.block_ids_json));
    const locators = z.array(LocatorSchema).parse(JSON.parse(row.locators_json));
    const handleId = randomUUID();
    const refId = row.ref_type === "fact" ? factId : row.source_version_id;
    if (refId === null) {
      throw new ApiError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "事实检索命中缺少事实身份",
      });
    }
    this.db
      .prepare(
        `INSERT INTO selection_handles(
          id, index_generation_id, ref_id, ref_type, chunk_id, source_id,
          source_version_id, occurrence_id, section_id, fact_id, fact_version_id,
          block_ids_json, locators_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handleId,
        generationId,
        refId,
        row.ref_type === "fact" ? "fact" : "source_version",
        row.id,
        row.source_id,
        row.source_version_id,
        row.occurrence_id,
        row.section_id,
        factId,
        row.fact_version_id,
        JSON.stringify(blockIds),
        JSON.stringify(locators),
        new Date().toISOString(),
      );
    return {
      refId,
      refType: row.ref_type === "fact" ? "fact" : "source_version",
      chunkId: row.id,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      sourceTitle: row.source_title,
      sourceKind: row.source_kind,
      occurrenceId: row.occurrence_id,
      factId,
      factVersionId: row.fact_version_id,
      matchedText: hit.matchedText,
      reason: hit.reason,
      keywordRank: hit.keywordRank,
      semanticRank: hit.semanticRank,
      availability: hit.availability,
      score: hit.score,
      scoreKind: hit.scoreKind,
      locators,
      blockIds,
      selectionHandle: encodeSelectionHandle({
        handleId,
        indexGenerationId: generationId,
        refType: row.ref_type === "fact" ? "fact" : "source_version",
        refId,
      }),
    };
  }

  private sourceFileUrl(sourceVersionId: string): string {
    const row = z
      .strictObject({ snapshot_blob_hash: z.string() })
      .parse(
        this.db
          .prepare("SELECT snapshot_blob_hash FROM source_versions WHERE id = ?")
          .get(sourceVersionId),
      );
    return `/api/v1/files/${row.snapshot_blob_hash}`;
  }

  private sourceTitle(sourceVersionId: string | null): string | null {
    if (sourceVersionId === null) return null;
    const row = this.db
      .prepare(
        `SELECT s.title FROM source_versions sv JOIN sources s ON s.id = sv.source_id WHERE sv.id = ?`,
      )
      .get(sourceVersionId);
    if (row === undefined) return null;
    return z.strictObject({ title: z.string() }).parse(row).title;
  }
}

export function encodeSelectionHandle(input: {
  handleId: string;
  indexGenerationId: string;
  refType: "source_version" | "fact";
  refId: string;
}): string {
  return `sel1:${Buffer.from(stableJson(input), "utf8").toString("base64url")}`;
}

function decodeSelectionHandle(value: string): string {
  if (!value.startsWith("sel1:")) {
    return z.uuid().parse(value);
  }
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")) as unknown;
    return z.strictObject({
      handleId: z.uuid(),
      indexGenerationId: z.uuid(),
      refType: z.enum(["source_version", "fact"]),
      refId: z.uuid(),
    }).parse(decoded).handleId;
  } catch {
    throw new ApiError({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "检索选择句柄无效",
    });
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
