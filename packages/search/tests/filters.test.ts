import { describe, expect, it } from "vitest";
import {
  buildSqlFilterClause,
  filterCandidates,
  matchesHardFilters,
  parseHardFilters,
  presentAiFilterHints,
} from "../src/index.js";
import { MERCHANT_A, MERCHANT_B, makeCandidate } from "./helpers.js";

describe("hard filters", () => {
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

  it("商家、日期、类型、受众、功能、过时条件同时严格生效", () => {
    const candidate = makeCandidate({
      refId: "chunk-a",
      mediaKind: "image",
      tags: ["经营"],
    });
    expect(matchesHardFilters(candidate, filters)).toBe(true);
    expect(filterCandidates([candidate], filters)).toHaveLength(1);
  });

  it("任一维度不符即排除，日期未知不能猜命中", () => {
    const candidates = [
      makeCandidate({ refId: "wrong-merchant", merchantId: MERCHANT_B, mediaKind: "image" }),
      makeCandidate({ refId: "wrong-date", recordDate: "2025-05-10", mediaKind: "image" }),
      makeCandidate({
        refId: "unknown-date",
        recordDate: null,
        effectiveFrom: null,
        effectiveTo: null,
        mediaKind: "image",
      }),
      makeCandidate({ refId: "wrong-kind", mediaKind: "video" }),
      makeCandidate({ refId: "wrong-audience", audience: ["培训"], mediaKind: "image" }),
      makeCandidate({ refId: "wrong-function", functions: ["导出"], mediaKind: "image" }),
      makeCandidate({ refId: "obsolete", obsolete: true, mediaKind: "image" }),
      makeCandidate({
        refId: "unknown-merchant",
        merchantId: null,
        mediaKind: "image",
      }),
    ];
    expect(filterCandidates(candidates, filters)).toEqual([]);
  });

  it("有效期区间与日期条件相交时通过", () => {
    const candidate = makeCandidate({
      refId: "effective-range",
      recordDate: null,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      mediaKind: "image",
    });
    expect(matchesHardFilters(candidate, filters)).toBe(true);
  });

  it("AI 推断提示保持可移除，且不会自动进入硬过滤", () => {
    const hints = presentAiFilterHints([
      {
        schemaVersion: 1,
        source: "ai",
        removable: true,
        confidence: 0.8,
        reason: "问题提到另一商家",
        kind: "merchant",
        merchantId: MERCHANT_B,
      },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.removable).toBe(true);

    const noMerchantFilter = parseHardFilters({ schemaVersion: 1 });
    expect(
      filterCandidates([makeCandidate({ refId: "kept", merchantId: MERCHANT_A })], noMerchantFilter),
    ).toHaveLength(1);
  });

  it("SQL 过滤片段全部参数化并覆盖同一维度", () => {
    const clause = buildSqlFilterClause(filters);
    expect(clause.sql).toContain("merchant_id = ?");
    expect(clause.sql).toContain("media_kind IN (?)");
    expect(clause.sql).toContain("json_each(chunk_search.audience_json)");
    expect(clause.sql).toContain("obsolete = 0");
    expect(clause.params).toEqual([
      MERCHANT_A,
      "2026-05-01",
      "2026-05-31",
      "2026-05-31",
      "2026-05-01",
      "image",
      "管理层",
      "搜索",
      "available",
    ]);
  });
});
