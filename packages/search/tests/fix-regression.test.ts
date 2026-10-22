import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ChunkSectionsInputSchema, chunkSections, ChunkSearchRowSchema,
  ensureChunkSearchSchema, replaceChunkSearchRows, searchChunks,
  normalizeVector, l2Norm, cosineSimilarity, encodeNormalizedVector, decodeNormalizedVector,
  cosineRank, type ChunkBlockInput, type ChunkDraft, type ChunkSearchRow,
} from "../src/index.js";
import { excerptForTokens } from "../src/tokenize.js";
import { makeSearchRow, makeNamespace, makeCandidate, SOURCE_VERSION_ID, OCCURRENCE_ID } from "./helpers.js";

const base = makeSearchRow();
const metadata = {
  merchantId: base.merchantId, mediaKind: base.mediaKind, recordDate: base.recordDate,
  effectiveFrom: null, effectiveTo: null, audience: base.audience, functions: base.functions,
  obsolete: false, availability: base.availability,
};
function section(blocks: ChunkBlockInput[]) {
  return { sectionId: "s1", title: "证据", page: null, sourceVersionId: SOURCE_VERSION_ID, tags: [], metadata, blocks };
}
function rowOf(draft: ChunkDraft): ChunkSearchRow {
  const { schemaVersion: _schemaVersion, refId, text, ...rest } = draft.candidate;
  return { chunkId: refId, body: text, ...rest };
}
function withDb(run: (db: Database.Database) => void): void {
  const db = new Database(":memory:");
  try { ensureChunkSearchSchema(db); run(db); } finally { db.close(); }
}
function assertStored(db: Database.Database, drafts: ChunkDraft[]): void {
  replaceChunkSearchRows(db, drafts.map(rowOf));
  for (const draft of drafts) {
    expect(db.prepare("SELECT body_text AS body FROM chunk_search WHERE chunk_id = ?").get(draft.candidate.refId)).toEqual({ body: draft.candidate.text });
    expect(/[\uD800-\uDFFF]/u.test(draft.candidate.text)).toBe(false);
    expect(Array.from(draft.candidate.text).length).toBeLessThanOrEqual(1200);
  }
}
const invalidMetadata: Array<[string, Partial<ChunkSearchRow>]> = [
  ["long title", { title: "销".repeat(501) }],
  ["many tags", { tags: Array.from({ length: 201 }, (_, i) => `标签${i}`) }],
  ["many audience", { audience: Array.from({ length: 101 }, (_, i) => `受众${i}`) }],
  ["many functions", { functions: Array.from({ length: 101 }, (_, i) => `功能${i}`) }],
  ["reversed dates", { effectiveFrom: "2026-12-31", effectiveTo: "2026-01-01" }],
  ["blank normalized label", { audience: ["   "] }],
  ["expanded normalized label", { functions: ["㍿".repeat(100)] }],
];
describe("F1 write/read schema closure and rectangular input", () => {
  it.each(invalidMetadata)("rejects %s before replacing any SQLite row", (_name, extra) => withDb(db => {
    replaceChunkSearchRows(db, [base]);
    const bad = { ...base, chunkId: "bad", ...extra };
    expect(() => replaceChunkSearchRows(db, [{ ...base, body: "不应写入" }, bad])).toThrow();
    expect(db.prepare("SELECT chunk_id, body_text FROM chunk_search").all()).toEqual([{ chunk_id: base.chunkId, body_text: base.body }]);
    expect(searchChunks(db, "销售", { schemaVersion: 1 }).map(h => h.candidate.refId)).toEqual([base.chunkId]);
  }));
  it("reads accepted boundary metadata after normalization", () => withDb(db => {
    const row = { ...base, title: "销".repeat(500), tags: Array.from({ length: 200 }, (_, i) => `标签${i}`), audience: Array.from({ length: 100 }, () => "Ａ".repeat(100)), functions: Array.from({ length: 100 }, () => "㍿".repeat(25)), effectiveFrom: "2026-01-01", effectiveTo: "2026-01-01" };
    expect(ChunkSearchRowSchema.safeParse(row).success).toBe(true);
    replaceChunkSearchRows(db, [row]);
    const hits = searchChunks(db, "销售", { schemaVersion: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.candidate.tags).toEqual(row.tags);
    expect(hits[0]?.candidate.audience[0]).toBe("a".repeat(100));
    expect(hits[0]?.candidate.functions[0]).toBe("株式会社".repeat(25));
  }));
  it.each([{ rows: [["A", "B", "独有证据9287"]] }, { rows: [["A"]] }])("rejects nonrectangular rows $rows at the parsing boundary", ({ rows }) => {
    const input = [section([{ kind: "table", blockId: "table", columns: ["商家", "期间"], rows }])];
    expect(ChunkSectionsInputSchema.safeParse(input).success).toBe(false);
    expect(() => chunkSections(input)).toThrow();
  });
  it("rejects section metadata and tags before producing drafts", () => {
    const input = section([{ kind: "text", blockId: "b", text: "销售" }]);
    expect(ChunkSectionsInputSchema.safeParse([{ ...input, metadata: { ...metadata, effectiveFrom: "2026-12-31", effectiveTo: "2026-01-01" } }]).success).toBe(false);
    expect(ChunkSectionsInputSchema.safeParse([{ ...input, tags: Array.from({ length: 201 }, () => "标签") }]).success).toBe(false);
  });
  it("keeps every rectangular cell searchable", () => withDb(db => {
    const drafts = chunkSections([section([{ kind: "table", blockId: "t", columns: ["商家", "期间", "证据"], rows: [["商家A", "2026-05", "独有证据9287"]] }])]);
    assertStored(db, drafts);
    expect(searchChunks(db, "独有证据9287", { schemaVersion: 1 })).toHaveLength(1);
  }));
});
describe("F2 Unicode and exact contributing block IDs", () => {
  it("locates the original block for the top SQLite overlap hit", () => withDb(db => {
    const drafts = chunkSections([section([{ kind: "text", blockId: "b1", text: "甲".repeat(694) + "原块证据A" }, { kind: "text", blockId: "b2", text: "乙".repeat(110) }])]);
    assertStored(db, drafts);
    const top = searchChunks(db, "原块证据", { schemaVersion: 1 })[0];
    expect(top).toBeDefined();
    const hitDraft = drafts.find(d => d.candidate.refId === top?.candidate.refId);
    expect(hitDraft?.blockIds).toContain("b1");
    expect(drafts[1]?.blockIds).toEqual(["b1", "b2"]);
  }));
  it("keeps all tail contributors but excludes earlier and future blocks", () => {
    const drafts = chunkSections([section([
      { kind: "text", blockId: "early", text: "甲".repeat(590) },
      { kind: "text", blockId: "tail-a", text: "乙".repeat(50) },
      { kind: "text", blockId: "tail-b", text: "丙".repeat(50) },
      { kind: "text", blockId: "next", text: "丁".repeat(110) },
      { kind: "image_context", blockId: "future", occurrenceId: OCCURRENCE_ID, text: "图片上下文" },
    ])]);
    expect(drafts[1]?.blockIds).toEqual(["tail-a", "tail-b", "next"]);
    expect(drafts[1]?.overlapChars).toBe(100);
  });
  it.each(["text", "image_context"] as const)("preserves supplementary Han in %s splits and SQLite", kind => withDb(db => {
    const text = "甲".repeat(795) + "𠮷" + "乙".repeat(1000);
    const block: ChunkBlockInput = kind === "text" ? { kind, blockId: "unicode", text } : { kind, blockId: "unicode", occurrenceId: OCCURRENCE_ID, text };
    const drafts = chunkSections([section([block])]);
    assertStored(db, drafts);
    const recovered = drafts.map(d => Array.from(d.candidate.text.slice("证据\n\n".length)).slice(d.overlapChars).join("")).join("");
    expect(recovered).toBe(text);
    expect(drafts.every(d => Array.from(d.candidate.text).length <= 800)).toBe(true);
    expect(searchChunks(db, "𠮷", { schemaVersion: 1 }).length).toBeGreaterThan(0);
  }));
  it("preserves supplementary Han through table continuation", () => withDb(db => {
    const prefix = "证据\n\n表格 t\n说明\n";
    const limit = 1200 - prefix.length - 4;
    const text = "甲".repeat(limit - 1) + "𠮷" + "乙".repeat(1500);
    const drafts = chunkSections([section([{ kind: "table", blockId: "t", columns: ["说明"], rows: [[text]] }])]);
    assertStored(db, drafts);
    expect(drafts.map(d => d.candidate.text.slice(prefix.length).replace(/（行续）$/u, "")).join("")).toBe(text);
    expect(searchChunks(db, "𠮷", { schemaVersion: 1 }).length).toBeGreaterThan(0);
  }));
  it("slices Unicode overlap with its contributing source", () => withDb(db => {
    const text = "甲".repeat(600) + "𠮷" + "乙".repeat(99);
    const drafts = chunkSections([section([
      { kind: "text", blockId: "unicode-tail", text },
      { kind: "text", blockId: "next", text: "丙".repeat(110) },
    ])]);
    assertStored(db, drafts);
    expect(drafts[1]?.candidate.text).toContain("证据\n\n𠮷" + "乙".repeat(99));
    expect(drafts[1]?.overlapChars).toBe(100);
    expect(drafts[1]?.blockIds).toEqual(["unicode-tail", "next"]);
  }));
  it("rejects malformed Unicode at the text boundary", () => {
    const input = [section([{ kind: "image_context", blockId: "bad", occurrenceId: OCCURRENCE_ID, text: "孤立代理\ud842" }])];
    expect(ChunkSectionsInputSchema.safeParse(input).success).toBe(false);
    expect(ChunkSearchRowSchema.safeParse({ ...base, body: "孤立代理\udfb7" }).success).toBe(false);
  });
  it("does not split surrogate pairs in snippets", () => {
    const text = "甲".repeat(159) + "𠮷" + "乙".repeat(500);
    const excerpt = excerptForTokens(text, [], 160);
    expect(/[\uD800-\uDFFF]/u.test(excerpt)).toBe(false);
    expect(excerpt).toBe("甲".repeat(159) + "𠮷");
  });
});
describe("F3 stable finite vector normalization", () => {
  it.each([1e200, 1e-200, Number.MAX_VALUE, Number.MIN_VALUE])("normalizes scale %s and roundtrips a real SQLite BLOB", scale => withDb(db => {
    const vector = [scale, scale];
    const normalized = normalizeVector(vector);
    expect(normalized[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(normalized[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(l2Norm(normalized)).toBeCloseTo(1, 12);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 12);
    db.exec("CREATE TABLE embeddings(vector BLOB NOT NULL)");
    db.prepare("INSERT INTO embeddings VALUES (?)").run(encodeNormalizedVector(vector, 2));
    const result: unknown = db.prepare("SELECT vector FROM embeddings").get();
    if (typeof result !== "object" || result === null || !("vector" in result) || !(result.vector instanceof Uint8Array)) throw new Error("SQLite did not return BLOB");
    const decoded = decodeNormalizedVector(result.vector, 2);
    expect(decoded[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(decoded[1]).toBeCloseTo(Math.SQRT1_2, 6);
    const namespace = makeNamespace({ dimension: 2 });
    const ranked = cosineRank({ queryVector: vector, queryNamespace: namespace, candidates: [{ schemaVersion: 1, candidate: makeCandidate(), namespace, vector: decoded }] });
    expect(ranked[0]?.score).toBeCloseTo(1, 6);
  }));
  it("retains direction for mixed signs and extreme scales", () => {
    const normalized = normalizeVector([Number.MAX_VALUE, 0, -Number.MAX_VALUE]);
    expect(normalized[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(normalized[1]).toBe(0);
    expect(normalized[2]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(cosineSimilarity([1e-200, -1e-200], [-1e200, 1e200])).toBeCloseTo(-1, 12);
  });
});
