import { SearchValidationError } from "./errors.js";
import { assertNamespace, sameNamespace } from "./namespace.js";
import {
  EmbeddingRecordSchema,
  KeywordRankedSchema,
  RankedHitSchema,
  RrfOutcomeSchema,
  SemanticRankedSchema,
  SemanticStateSchema,
  type ChunkCandidate,
  type EmbeddingNamespace,
  type EmbeddingRecord,
  type KeywordRanked,
  type RankedHit,
  type RrfOutcome,
  type SemanticRanked,
  type SemanticState,
} from "./schemas.js";
import { excerptForTokens, tokenizeForFts } from "./tokenize.js";

export const SEMANTIC_LIMIT = 50;
export const RRF_K = 60;
export const RRF_LIMIT = 20;

export interface CosineRankInput {
  readonly queryVector: readonly number[];
  readonly queryNamespace: EmbeddingNamespace;
  readonly candidates: readonly EmbeddingRecord[];
  readonly limit?: number;
}

export interface RrfInput {
  readonly keyword: readonly KeywordRanked[];
  readonly semantic: readonly SemanticRanked[];
  readonly semanticState: SemanticState;
  readonly limit?: number;
}

interface MergeBucket {
  readonly candidate: ChunkCandidate;
  keyword: KeywordRanked | null;
  semantic: SemanticRanked | null;
  score: number;
}

function assertFiniteVector(
  vector: readonly number[],
  dimension: number,
  context: string,
): void {
  if (vector.length !== dimension) {
    throw new SearchValidationError(
      "DIMENSION_MISMATCH",
      `${context} 维度 ${vector.length} 与 namespace 维度 ${dimension} 不一致`,
    );
  }
  for (const [index, value] of vector.entries()) {
    if (!Number.isFinite(value)) {
      throw new SearchValidationError(
        "VECTOR_INVALID",
        `${context} 第 ${index} 个分量不是有限数`,
      );
    }
  }
}

export function l2Norm(vector: readonly number[]): number {
  let scale = 0;
  for (const value of vector) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return 0;
  let sum = 0;
  for (const value of vector) sum += (value / scale) ** 2;
  return scale * Math.sqrt(sum);
}

export function normalizeVector(vector: readonly number[]): number[] {
  if (vector.length === 0) {
    throw new SearchValidationError("VECTOR_INVALID", "向量不能为空");
  }
  let scale = 0;
  for (const [index, value] of vector.entries()) {
    if (!Number.isFinite(value)) {
      throw new SearchValidationError("VECTOR_INVALID", `向量第 ${index} 个分量不是有限数`);
    }
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) {
    throw new SearchValidationError("VECTOR_ZERO_NORM", "向量范数为 0，不能用于 cosine");
  }
  const scaled = vector.map((value) => value / scale);
  const norm = l2Norm(scaled);
  return scaled.map((value) => value / norm);
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length) {
    throw new SearchValidationError(
      "DIMENSION_MISMATCH",
      `向量维度不一致：${left.length} 与 ${right.length}`,
    );
  }
  const normalizedLeft = normalizeVector(left);
  const normalizedRight = normalizeVector(right);
  let score = 0;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    const leftValue = normalizedLeft[index];
    const rightValue = normalizedRight[index];
    if (leftValue !== undefined && rightValue !== undefined) score += leftValue * rightValue;
  }
  return Math.max(-1, Math.min(1, score));
}

export function encodeNormalizedVector(
  vector: readonly number[],
  dimension?: number,
): Buffer {
  if (dimension !== undefined && vector.length !== dimension) {
    throw new SearchValidationError(
      "DIMENSION_MISMATCH",
      `向量维度 ${vector.length} 与 namespace 维度 ${dimension} 不一致`,
    );
  }
  const normalized = normalizeVector(vector);
  const buffer = Buffer.allocUnsafe(normalized.length * 4);
  normalized.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function decodeNormalizedVector(
  blob: Uint8Array,
  dimension: number,
): number[] {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new SearchValidationError("DIMENSION_MISMATCH", "namespace 维度必须是正整数");
  }
  if (blob.byteLength !== dimension * 4) {
    throw new SearchValidationError(
      "DIMENSION_MISMATCH",
      `BLOB 字节数 ${blob.byteLength} 与维度 ${dimension} 不匹配`,
    );
  }
  const buffer = Buffer.from(blob);
  const vector: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    vector.push(buffer.readFloatLE(index * 4));
  }
  for (const [index, value] of vector.entries()) {
    if (!Number.isFinite(value)) {
      throw new SearchValidationError(
        "VECTOR_INVALID",
        `BLOB 第 ${index} 个分量不是有限数`,
      );
    }
  }
  const norm = l2Norm(vector);
  if (norm === 0) {
    throw new SearchValidationError("VECTOR_ZERO_NORM", "BLOB 向量范数为 0");
  }
  if (Math.abs(norm - 1) > 0.001) {
    throw new SearchValidationError(
      "VECTOR_INVALID",
      `BLOB 向量未归一化，L2 范数为 ${norm}`,
    );
  }
  return vector;
}

export function cosineRank(input: CosineRankInput): SemanticRanked[] {
  const namespace = assertNamespace(input.queryNamespace);
  assertFiniteVector(input.queryVector, namespace.dimension, "query vector");
  const query = normalizeVector(input.queryVector);
  const requestedLimit = input.limit ?? SEMANTIC_LIMIT;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new SearchValidationError("VECTOR_INVALID", "limit 必须是正整数");
  }
  const limit = Math.min(requestedLimit, SEMANTIC_LIMIT);
  const records = input.candidates.map((record) => EmbeddingRecordSchema.parse(record));

  for (const record of records) {
    const recordNamespace = assertNamespace(record.namespace);
    if (!sameNamespace(recordNamespace, namespace)) {
      throw new SearchValidationError(
        "NAMESPACE_MISMATCH",
        `候选 ${record.candidate.refId} 的 namespace 与查询不一致`,
      );
    }
    assertFiniteVector(record.vector, namespace.dimension, `candidate ${record.candidate.refId}`);
  }

  const scored = records.map((record) => {
    const vector = normalizeVector(record.vector);
    let score = 0;
    for (let index = 0; index < query.length; index += 1) {
      const left = query[index];
      const right = vector[index];
      if (left !== undefined && right !== undefined) score += left * right;
    }
    return {
      record,
      score: Math.max(-1, Math.min(1, score)),
    };
  });

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.record.candidate.locationKey.localeCompare(right.record.candidate.locationKey) ||
      left.record.candidate.refId.localeCompare(right.record.candidate.refId),
  );

  return scored.slice(0, limit).map((entry, index) =>
    SemanticRankedSchema.parse({
      schemaVersion: 1,
      candidate: entry.record.candidate,
      semanticRank: index + 1,
      score: entry.score,
      matchedText:
        entry.record.candidate.text.length > 0
          ? excerptForTokens(entry.record.candidate.text, [])
          : entry.record.candidate.title,
      reason: `语义 cosine=${entry.score.toFixed(6)}，namespace ${namespace.fingerprint.slice(0, 12)}`,
    }),
  );
}

function mergeKey(candidate: ChunkCandidate): string {
  return [
    candidate.sourceVersionId,
    candidate.refType,
    candidate.locationKey,
    candidate.occurrenceId ?? "",
  ].join("\u0000");
}

function buildReason(
  keyword: KeywordRanked | null,
  semantic: SemanticRanked | null,
  degradationMessage: string | null,
): string {
  const parts: string[] = [];
  if (keyword !== null) parts.push(`关键词第 ${keyword.keywordRank} 名`);
  if (semantic !== null) parts.push(`语义第 ${semantic.semanticRank} 名`);
  if (degradationMessage !== null) parts.push(`仅关键词：${degradationMessage}`);
  parts.push("RRF k=60，分数不是概率");
  return parts.join("；");
}

export function rrfMerge(input: RrfInput): RrfOutcome {
  const semanticState = SemanticStateSchema.parse(input.semanticState);
  const keyword = input.keyword.map((entry) => KeywordRankedSchema.parse(entry));
  const semantic = input.semantic.map((entry) => SemanticRankedSchema.parse(entry));

  if (semanticState.status === "unavailable" && semantic.length > 0) {
    throw new SearchValidationError(
      "SEMANTIC_STATE_INVALID",
      "embedding 不可用时不能合并语义候选",
    );
  }

  const requestedLimit = input.limit ?? RRF_LIMIT;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new SearchValidationError("VECTOR_INVALID", "limit 必须是正整数");
  }
  const limit = Math.min(requestedLimit, RRF_LIMIT);

  const keywordBest = new Map<string, KeywordRanked>();
  for (const entry of keyword) {
    const key = mergeKey(entry.candidate);
    const existing = keywordBest.get(key);
    if (existing === undefined || entry.keywordRank < existing.keywordRank) {
      keywordBest.set(key, entry);
    }
  }

  const semanticBest = new Map<string, SemanticRanked>();
  for (const entry of semantic) {
    const key = mergeKey(entry.candidate);
    const existing = semanticBest.get(key);
    if (existing === undefined || entry.semanticRank < existing.semanticRank) {
      semanticBest.set(key, entry);
    }
  }

  const buckets = new Map<string, MergeBucket>();
  for (const [key, entry] of keywordBest) {
    buckets.set(key, {
      candidate: entry.candidate,
      keyword: entry,
      semantic: null,
      score: 1 / (RRF_K + entry.keywordRank),
    });
  }
  for (const [key, entry] of semanticBest) {
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.semantic = entry;
      existing.score += 1 / (RRF_K + entry.semanticRank);
    } else {
      buckets.set(key, {
        candidate: entry.candidate,
        keyword: null,
        semantic: entry,
        score: 1 / (RRF_K + entry.semanticRank),
      });
    }
  }

  const degradation =
    semanticState.status === "unavailable"
      ? { code: semanticState.code, message: semanticState.message }
      : null;

  const ranked = [...buckets.values()]
    .sort((left, right) => {
      const leftBestRank = Math.min(
        left.keyword?.keywordRank ?? Number.POSITIVE_INFINITY,
        left.semantic?.semanticRank ?? Number.POSITIVE_INFINITY,
      );
      const rightBestRank = Math.min(
        right.keyword?.keywordRank ?? Number.POSITIVE_INFINITY,
        right.semantic?.semanticRank ?? Number.POSITIVE_INFINITY,
      );
      return (
        right.score - left.score ||
        leftBestRank - rightBestRank ||
        left.candidate.locationKey.localeCompare(right.candidate.locationKey) ||
        left.candidate.refId.localeCompare(right.candidate.refId)
      );
    })
    .slice(0, limit)
    .map((bucket) => {
      const matchedText =
        bucket.keyword !== null && bucket.keyword.matchedText.length > 0
          ? bucket.keyword.matchedText
          : (bucket.semantic?.matchedText ?? bucket.candidate.text.slice(0, 160));
      const hit: RankedHit = {
        schemaVersion: 1,
        refId: bucket.candidate.refId,
        refType: bucket.candidate.refType,
        occurrenceId: bucket.candidate.occurrenceId,
        sourceVersionId: bucket.candidate.sourceVersionId,
        matchedText,
        reason: buildReason(bucket.keyword, bucket.semantic, degradation?.message ?? null),
        keywordRank: bucket.keyword?.keywordRank ?? null,
        semanticRank: bucket.semantic?.semanticRank ?? null,
        availability: bucket.candidate.availability,
        score: Number(bucket.score.toFixed(12)),
        scoreKind: "rrf_k60",
        locationKey: bucket.candidate.locationKey,
      };
      return RankedHitSchema.parse(hit);
    });

  return RrfOutcomeSchema.parse({
    schemaVersion: 1,
    mode: semanticState.status === "available" ? "hybrid" : "keyword_only",
    degradation,
    hits: ranked,
  });
}

export function keywordOnlyFallback(
  keyword: readonly KeywordRanked[],
  reason = "embedding 服务不可用，降级为关键词检索",
): RrfOutcome {
  return rrfMerge({
    keyword,
    semantic: [],
    semanticState: {
      status: "unavailable",
      code: "EMBEDDING_UNAVAILABLE",
      message: reason,
    },
  });
}

export function semanticExcerpt(candidate: ChunkCandidate): string {
  return excerptForTokens(candidate.text, tokenizeForFts(candidate.title).map((token) => token.value));
}
