import { describe, expect, it } from "vitest";
import {
  RRF_K,
  SearchValidationError,
  cosineRank,
  cosineSimilarity,
  decodeNormalizedVector,
  encodeNormalizedVector,
  keywordOnlyFallback,
  l2Norm,
  normalizeVector,
  rrfMerge,
  type EmbeddingNamespace,
  type EmbeddingRecord,
  type KeywordRanked,
  type SemanticRanked,
} from "../src/index.js";
import { makeCandidate, makeNamespace } from "./helpers.js";

function record(
  namespace: EmbeddingNamespace,
  index: number,
  vector: number[],
): EmbeddingRecord {
  return {
    schemaVersion: 1,
    candidate: makeCandidate({
      refId: `chunk-${index}`,
      locationKey: `section:s-1:text:${index}`,
      text: `候选正文 ${index}`,
    }),
    namespace,
    vector,
  };
}

function keywordEntry(index: number, rank: number, location?: string): KeywordRanked {
  return {
    schemaVersion: 1,
    candidate: makeCandidate({
      refId: `kw-${index}`,
      locationKey: location ?? `section:s-1:text:${index}`,
      text: `关键词正文 ${index}`,
    }),
    keywordRank: rank,
    matchedText: `关键词匹配 ${index}`,
    reason: "测试关键词命中",
  };
}

function semanticEntry(index: number, rank: number, location?: string): SemanticRanked {
  return {
    schemaVersion: 1,
    candidate: makeCandidate({
      refId: `sem-${index}`,
      locationKey: location ?? `section:s-1:text:${index}`,
      text: `语义正文 ${index}`,
    }),
    semanticRank: rank,
    score: 0.9 - rank * 0.01,
    matchedText: `语义匹配 ${index}`,
    reason: "测试语义命中",
  };
}

describe("vector validation and cosine", () => {
  it("归一化、BLOB 编解码真实往返", () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8]);
    expect(l2Norm(normalizeVector([1, 2, 3]))).toBeCloseTo(1, 12);
    const blob = encodeNormalizedVector([3, 4], 2);
    expect(blob.byteLength).toBe(8);
    const decoded = decodeNormalizedVector(blob, 2);
    expect(decoded[0]).toBeCloseTo(0.6, 6);
    expect(decoded[1]).toBeCloseTo(0.8, 6);
    expect(() => decodeNormalizedVector(blob, 3)).toThrow(SearchValidationError);
    expect(() => normalizeVector([0, 0])).toThrow(SearchValidationError);
    expect(() => normalizeVector([1, Number.NaN])).toThrow(SearchValidationError);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 12);
  });

  it("拒绝混 namespace、维度不符和 0 范数", () => {
    const namespace = makeNamespace();
    const other = makeNamespace({ preprocessingVersion: "other-v1" });
    expect(() =>
      cosineRank({
        queryVector: [1, 0, 0],
        queryNamespace: namespace,
        candidates: [record(other, 1, [1, 0, 0])],
      }),
    ).toThrow(SearchValidationError);

    expect(() =>
      cosineRank({
        queryVector: [1, 0, 0],
        queryNamespace: namespace,
        candidates: [record(namespace, 1, [1, 0])],
      }),
    ).toThrow(SearchValidationError);

    expect(() =>
      cosineRank({
        queryVector: [0, 0, 0],
        queryNamespace: namespace,
        candidates: [record(namespace, 1, [1, 0, 0])],
      }),
    ).toThrow(SearchValidationError);

    expect(() =>
      cosineRank({
        queryVector: [1, 0, 0],
        queryNamespace: namespace,
        candidates: [record(namespace, 1, [0, 0, 0])],
      }),
    ).toThrow(SearchValidationError);

    expect(() =>
      cosineRank({
        queryVector: [1, 0, 0],
        queryNamespace: namespace,
        candidates: [record(namespace, 1, [Number.NaN, 0, 0])],
      }),
    ).toThrow();
  });

  it("按 cosine 排序并最多返回 50 条", () => {
    const namespace = makeNamespace();
    const candidates = Array.from({ length: 51 }, (_, index) =>
      record(namespace, index, [Math.max(0.01, 1 - index / 100), 0.1, 0]),
    );
    const ranked = cosineRank({
      queryVector: [1, 0, 0],
      queryNamespace: namespace,
      candidates,
    });
    expect(ranked).toHaveLength(50);
    expect(ranked[0]?.candidate.refId).toBe("chunk-0");
    expect(ranked[0]?.semanticRank).toBe(1);
    expect(ranked[49]?.semanticRank).toBe(50);
  });
});

describe("RRF merge", () => {
  it("固定 k=60，保留两路 rank，按位置合并", () => {
    const result = rrfMerge({
      keyword: [keywordEntry(1, 1, "loc-a"), keywordEntry(2, 2, "loc-b")],
      semantic: [
        semanticEntry(3, 1, "loc-c"),
        semanticEntry(4, 3, "loc-a"),
      ],
      semanticState: { status: "available" },
    });
    expect(result.mode).toBe("hybrid");
    expect(result.degradation).toBeNull();
    expect(result.hits.map((hit) => hit.locationKey)).toEqual(["loc-a", "loc-c", "loc-b"]);
    expect(result.hits[0]?.keywordRank).toBe(1);
    expect(result.hits[0]?.semanticRank).toBe(3);
    expect(result.hits[0]?.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 3), 12);
    expect(result.hits.every((hit) => hit.scoreKind === "rrf_k60")).toBe(true);
    expect(result.hits.every((hit) => hit.reason.includes("分数不是概率"))).toBe(true);
  });

  it("同一来源位置在同一路重复命中只计一次", () => {
    const result = rrfMerge({
      keyword: [
        keywordEntry(1, 1, "same-location"),
        keywordEntry(2, 4, "same-location"),
        keywordEntry(3, 2, "other-location"),
      ],
      semantic: [],
      semanticState: { status: "available" },
    });
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.locationKey).toBe("same-location");
    expect(result.hits[0]?.keywordRank).toBe(1);
  });

  it("同一图片 occurrence 的不同上下文不合并", () => {
    const occurrenceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const first = keywordEntry(1, 1, "image:1");
    const second = keywordEntry(2, 2, "image:2");
    first.candidate = makeCandidate({
      refId: "ctx-1",
      occurrenceId,
      locationKey: "image:1",
    });
    second.candidate = makeCandidate({
      refId: "ctx-2",
      occurrenceId,
      locationKey: "image:2",
    });
    const result = rrfMerge({
      keyword: [first, second],
      semantic: [],
      semanticState: { status: "available" },
    });
    expect(result.hits).toHaveLength(2);
  });

  it("最多返回 20 条", () => {
    const keyword = Array.from({ length: 25 }, (_, index) =>
      keywordEntry(index, index + 1, `loc-${index}`),
    );
    const result = rrfMerge({
      keyword,
      semantic: [],
      semanticState: { status: "available" },
    });
    expect(result.hits).toHaveLength(20);
  });

  it("embedding 不可用时关键词降级并明示状态", () => {
    const result = keywordOnlyFallback([keywordEntry(1, 1)], "未配置 embedding provider");
    expect(result.mode).toBe("keyword_only");
    expect(result.degradation).toEqual({
      code: "EMBEDDING_UNAVAILABLE",
      message: "未配置 embedding provider",
    });
    expect(result.hits[0]?.semanticRank).toBeNull();
    expect(result.hits[0]?.reason).toContain("未配置 embedding provider");
  });

  it("不可用状态下拒绝混入语义候选", () => {
    expect(() =>
      rrfMerge({
        keyword: [keywordEntry(1, 1)],
        semantic: [semanticEntry(2, 1)],
        semanticState: {
          status: "unavailable",
          code: "EMBEDDING_INVALID",
          message: "invalid",
        },
      }),
    ).toThrow(SearchValidationError);
  });
});
