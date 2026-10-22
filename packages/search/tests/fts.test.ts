import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  cosineRank,
  createEmbeddingNamespace,
  ensureChunkSearchSchema,
  filterCandidates,
  matchesHardFilters,
  parseHardFilters,
  replaceChunkSearchRows,
  rrfMerge,
  searchChunks,
  searchKeywordOnly,
  type EmbeddingRecord,
  type HardFilters,
} from "../src/index.js";
import { MERCHANT_A, MERCHANT_B, makeSearchRow } from "./helpers.js";

function withDb<T>(run: (db: Database.Database) => T): T {
  const db = new Database(":memory:");
  ensureChunkSearchSchema(db);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

describe("SQLite FTS5 keyword retrieval", () => {
  it("真实 FTS5 BM25 对标题和标签加权", () => {
    withDb((db) => {
      replaceChunkSearchRows(db, [
        makeSearchRow({
          chunkId: "title-hit",
          title: "销售日报",
          tags: ["经营"],
          body: "门店经营内容",
        }),
        makeSearchRow({
          chunkId: "tag-hit",
          title: "经营分析",
          tags: ["销售"],
          body: "门店经营内容",
        }),
        makeSearchRow({
          chunkId: "body-hit",
          title: "经营分析",
          tags: ["门店"],
          body: "销售 门店经营内容",
        }),
      ]);
      const hits = searchChunks(db, "销售", { schemaVersion: 1 });
      expect(hits.map((hit) => hit.candidate.refId)).toEqual([
        "title-hit",
        "tag-hit",
        "body-hit",
      ]);
      expect(hits[0]?.keywordRank).toBe(1);
      expect(hits[0]?.candidate.title).toBe("销售日报");
    });
  });

  it("top 50 上限由真实 SQL limit 生效", () => {
    withDb((db) => {
      const rows = Array.from({ length: 60 }, (_, index) =>
        makeSearchRow({
          chunkId: `chunk-${index}`,
          locationKey: `loc-${index}`,
          title: `销售日报 ${index}`,
          body: `销售 门店 经营 内容 ${index}`,
        }),
      );
      replaceChunkSearchRows(db, rows);
      const hits = searchChunks(db, "销售", { schemaVersion: 1 });
      expect(hits).toHaveLength(50);
      expect(hits.map((hit) => hit.keywordRank)).toEqual(
        Array.from({ length: 50 }, (_, index) => index + 1),
      );
    });
  });

  it("显式硬过滤在候选前落实，返回 0 违规", () => {
    withDb((db) => {
      const filters = parseHardFilters({
        schemaVersion: 1,
        merchantId: MERCHANT_A,
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
        mediaKinds: ["image"],
        audience: ["管理层"],
        functions: ["搜索"],
        obsolete: "exclude",
        availability: ["available"],
      });
      replaceChunkSearchRows(db, [
        makeSearchRow({
          chunkId: "match",
          mediaKind: "image",
          title: "销售看板",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "wrong-merchant",
          merchantId: MERCHANT_B,
          mediaKind: "image",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "wrong-date",
          recordDate: "2025-05-10",
          mediaKind: "image",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "wrong-kind",
          mediaKind: "video",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "wrong-audience",
          audience: ["培训"],
          mediaKind: "image",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "wrong-function",
          functions: ["导出"],
          mediaKind: "image",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "obsolete",
          obsolete: true,
          mediaKind: "image",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "effective-range",
          recordDate: null,
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-12-31",
          mediaKind: "image",
          body: "销售 有效期",
        }),
      ]);
      const hits = searchChunks(db, "销售", filters);
      expect(hits.map((hit) => hit.candidate.refId).sort()).toEqual([
        "effective-range",
        "match",
      ]);
      expect(hits.every((hit) => matchesHardFilters(hit.candidate, filters))).toBe(true);
      expect(
        filterCandidates(
          hits.map((hit) => hit.candidate),
          filters,
        ),
      ).toHaveLength(hits.length);
    });
  });

  it("单字走受控 LIKE，百分号下划线不成为通配符", () => {
    withDb((db) => {
      replaceChunkSearchRows(db, [
        makeSearchRow({
          chunkId: "literal-symbols",
          title: "100%_店主指南",
          tags: ["培训"],
          body: "门店销售",
        }),
        makeSearchRow({
          chunkId: "other",
          title: "普通指南",
          tags: [],
          body: "门店销售",
        }),
      ]);
      const single = searchChunks(db, "店", { schemaVersion: 1 });
      expect(single.map((hit) => hit.candidate.refId).sort()).toEqual([
        "literal-symbols",
        "other",
      ]);
      const mixed = searchChunks(db, "100%_店", { schemaVersion: 1 });
      expect(mixed.map((hit) => hit.candidate.refId)).toEqual(["literal-symbols"]);
      expect(() => searchChunks(db, "%_%", { schemaVersion: 1 })).toThrow();
    });
  });

  it("FTS 语法和 SQL 注入文本只作为词项处理", () => {
    withDb((db) => {
      replaceChunkSearchRows(db, [
        makeSearchRow({
          chunkId: "safe",
          title: "销售经营",
          tags: ["商家"],
          body: "门店销售经营分析",
        }),
      ]);
      const booleanQuery = searchChunks(db, "销售 OR 商家", { schemaVersion: 1 });
      expect(booleanQuery).toEqual([]);
      const injectionQuery = searchChunks(db, "销售'; DROP TABLE chunk_search; --", {
        schemaVersion: 1,
      });
      expect(injectionQuery).toEqual([]);
      const count = db.prepare("SELECT count(*) AS count FROM chunk_search").get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    });
  });

  it("无 embedding 服务时真实 FTS 降级并返回明确状态", () => {
    withDb((db) => {
      replaceChunkSearchRows(db, [
        makeSearchRow({ chunkId: "fallback", body: "销售 门店经营" }),
      ]);
      const outcome = searchKeywordOnly(
        db,
        "销售",
        { schemaVersion: 1 },
        "embedding provider 未配置",
      );
      expect(outcome.mode).toBe("keyword_only");
      expect(outcome.degradation?.code).toBe("EMBEDDING_UNAVAILABLE");
      expect(outcome.hits).toHaveLength(1);
      expect(outcome.hits[0]?.reason).toContain("embedding provider 未配置");
    });
  });

  it("真实 FTS 候选可进入 cosine 并按 RRF 合并", () => {
    withDb((db) => {
      replaceChunkSearchRows(db, [
        makeSearchRow({
          chunkId: "first",
          locationKey: "loc-first",
          title: "销售日报",
          body: "销售 门店经营",
        }),
        makeSearchRow({
          chunkId: "second",
          locationKey: "loc-second",
          title: "经营分析",
          body: "销售 门店经营",
        }),
      ]);
      const keyword = searchChunks(db, "销售", { schemaVersion: 1 });
      const namespace = createEmbeddingNamespace({
        schemaVersion: 1,
        provider: "dmall-test",
        model: "embedding-v1",
        preprocessingVersion: "nfkc-lower-v1",
        dimension: 3,
      });
      const records: EmbeddingRecord[] = keyword.map((hit, index) => ({
        schemaVersion: 1,
        candidate: hit.candidate,
        namespace,
        vector: index === 0 ? [1, 0, 0] : [0.8, 0.6, 0],
      }));
      const semantic = cosineRank({
        queryVector: [1, 0, 0],
        queryNamespace: namespace,
        candidates: records,
      });
      const outcome = rrfMerge({
        keyword,
        semantic,
        semanticState: { status: "available" },
      });
      expect(outcome.mode).toBe("hybrid");
      expect(outcome.hits).toHaveLength(2);
      expect(outcome.hits[0]?.keywordRank).not.toBeNull();
      expect(outcome.hits[0]?.semanticRank).toBe(1);
    });
  });

  it("SQL 过滤与内存过滤对商家条件一致，不猜 null 商家", () => {
    withDb((db) => {
      const filters: HardFilters = parseHardFilters({
        schemaVersion: 1,
        merchantId: MERCHANT_A,
      });
      replaceChunkSearchRows(db, [
        makeSearchRow({ chunkId: "known", merchantId: MERCHANT_A, body: "销售" }),
        makeSearchRow({ chunkId: "unknown", merchantId: null, body: "销售" }),
      ]);
      const hits = searchChunks(db, "销售", filters);
      expect(hits.map((hit) => hit.candidate.refId)).toEqual(["known"]);
      expect(hits.every((hit) => hit.candidate.merchantId === MERCHANT_A)).toBe(true);
    });
  });
});
