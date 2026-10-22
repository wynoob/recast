import { describe, expect, it } from "vitest";
import { CHUNK_HARD_MAX, CHUNK_OVERLAP_MAX, chunkSections } from "../src/index.js";
import { MERCHANT_A, OCCURRENCE_ID, SOURCE_VERSION_ID } from "./helpers.js";

const metadata = {
  merchantId: MERCHANT_A,
  mediaKind: "document" as const,
  recordDate: "2026-05-10",
  effectiveFrom: null,
  effectiveTo: null,
  audience: ["管理层"],
  functions: ["搜索"],
  obsolete: false,
  availability: "available" as const,
};

describe("chunkSections", () => {
  it("按章节边界和目标长度切分，重叠不超过 100 字", () => {
    const paragraphs = Array.from({ length: 18 }, (_, index) => {
      const marker = `第${index + 1}段`;
      return `${marker}门店销售、库存与补货分析，需要核对商家范围、统计期间和来源上下文。`.repeat(
        3,
      );
    });
    const drafts = chunkSections([
      {
        sectionId: "s-sales",
        title: "销售分析",
        page: 3,
        sourceVersionId: SOURCE_VERSION_ID,
        tags: ["销售", "经营"],
        metadata,
        blocks: [{ kind: "text", blockId: "b-sales", text: paragraphs.join("\n\n") }],
      },
      {
        sectionId: "s-training",
        title: "培训手册",
        page: 4,
        sourceVersionId: SOURCE_VERSION_ID,
        tags: ["培训"],
        metadata,
        blocks: [{ kind: "text", blockId: "b-training", text: "培训入口与权限说明。" }],
      },
    ]);

    const sales = drafts.filter((draft) => draft.candidate.title === "销售分析");
    const training = drafts.filter((draft) => draft.candidate.title === "培训手册");
    expect(sales.length).toBeGreaterThan(1);
    expect(training).toHaveLength(1);
    for (const draft of drafts) {
      expect(draft.candidate.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX);
      expect(draft.candidate.text.startsWith(`${draft.candidate.title}\n\n`)).toBe(true);
      expect(draft.overlapChars).toBeLessThanOrEqual(CHUNK_OVERLAP_MAX);
    }
    expect(sales.some((draft) => draft.overlapChars > 0)).toBe(true);
    const salesText = sales.filter((draft) => draft.chunkKind === "text");
    expect(
      salesText
        .slice(0, -1)
        .every(
          (draft) =>
            draft.candidate.text.length >= 300 && draft.candidate.text.length <= 800,
        ),
    ).toBe(true);
    expect(sales.every((draft) => draft.candidate.locationKey.startsWith("page:3:"))).toBe(true);
    expect(training[0]?.candidate.text).toContain("培训入口与权限说明");
    expect(training[0]?.candidate.text).not.toContain("第18段");
  });

  it("大表按行组切分，每块保留表头", () => {
    const rows = Array.from({ length: 60 }, (_, index) => [
      `行${index + 1}`,
      `商家${index + 1}`,
      "2026-05",
      "销售、库存、补货与门店经营说明".repeat(4),
    ]);
    const drafts = chunkSections([
      {
        sectionId: "s-table",
        title: "明细表",
        page: 8,
        sourceVersionId: SOURCE_VERSION_ID,
        tags: ["表格"],
        metadata,
        blocks: [
          {
            kind: "table",
            blockId: "b-table",
            columns: ["编号", "商家", "期间", "说明"],
            rows,
          },
        ],
      },
    ]);
    expect(drafts.length).toBeGreaterThan(1);
    for (const draft of drafts) {
      expect(draft.chunkKind).toBe("table");
      expect(draft.candidate.text).toContain("编号 | 商家 | 期间 | 说明");
      expect(draft.candidate.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX);
    }
  });

  it("事实独立成 ref，图片多上下文分别展开", () => {
    const drafts = chunkSections([
      {
        sectionId: "s-mixed",
        title: "证据",
        page: 9,
        sourceVersionId: SOURCE_VERSION_ID,
        tags: ["证据"],
        metadata,
        blocks: [
          { kind: "text", blockId: "b-text", text: "正文说明销售趋势。" },
          {
            kind: "fact",
            blockId: "b-fact",
            refId: "fact-123",
            text: "事实：2026-05 GMV 为 123 万元。",
            locatorKey: "fact:fact-123",
          },
          {
            kind: "image_context",
            blockId: "b-image-1",
            occurrenceId: OCCURRENCE_ID,
            text: "第一处上下文：截图展示门店销售看板。",
          },
          {
            kind: "image_context",
            blockId: "b-image-2",
            occurrenceId: OCCURRENCE_ID,
            text: "第二处上下文：同一截图用于培训说明。",
          },
        ],
      },
    ]);

    const facts = drafts.filter((draft) => draft.chunkKind === "fact");
    const images = drafts.filter((draft) => draft.chunkKind === "image_context");
    const textChunks = drafts.filter((draft) => draft.chunkKind === "text");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.candidate.refType).toBe("fact");
    expect(facts[0]?.candidate.refId).toBe("fact-123");
    expect(textChunks.some((draft) => draft.candidate.text.includes("事实："))).toBe(false);
    expect(images).toHaveLength(2);
    expect(images[0]?.candidate.occurrenceId).toBe(OCCURRENCE_ID);
    expect(images[0]?.candidate.locationKey).not.toBe(images[1]?.candidate.locationKey);
  });
});
