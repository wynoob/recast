import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ChunkBlockInputSchema, ChunkCandidateSchema, ChunkDraftSchema,
  ChunkSectionInputSchema, ChunkSectionsInputSchema, ChunkSearchRowSchema,
  EmbeddingRecordSchema, HardFiltersSchema, KeywordRankedSchema, SemanticRankedSchema,
  chunkSections, parseChunkSection, ensureChunkSearchSchema, replaceChunkSearchRows,
  searchChunks, filterCandidates, cosineRank, rrfMerge,
  type ChunkBlockInput, type ChunkDraft, type ChunkSearchRow,
} from "../src/index.js";
import { makeCandidate, makeSearchRow, makeNamespace, SOURCE_VERSION_ID, OCCURRENCE_ID } from "./helpers.js";

const base = makeSearchRow();
const metadata = {
  merchantId: base.merchantId, mediaKind: base.mediaKind, recordDate: base.recordDate,
  effectiveFrom: null, effectiveTo: null, audience: base.audience, functions: base.functions,
  obsolete: false, availability: base.availability,
};
function section(blocks: ChunkBlockInput[]) {
  return { sectionId: "s-fact", title: "事实章节", page: 1, sourceVersionId: SOURCE_VERSION_ID, tags: [], metadata, blocks };
}
function fact(text: string) {
  return { kind: "fact", blockId: "b-fact", refId: "fact-long", text, locatorKey: "fact:long" } satisfies ChunkBlockInput;
}
function rowOf(draft: ChunkDraft): ChunkSearchRow {
  const { schemaVersion: _version, refId, text, ...rest } = draft.candidate;
  return { chunkId: refId, body: text, ...rest };
}
function withDb(run: (db: Database.Database) => void): void {
  const db = new Database(":memory:");
  try { ensureChunkSearchSchema(db); run(db); } finally { db.close(); }
}

describe("fact index text budget", () => {
  it("rejects the parent's 1500-code-point fact instead of emitting an oversized chunk", () => {
    const input = [section([fact("数".repeat(1500)), { kind: "text", blockId: "text", text: "普通正文。" }])];
    expect(ChunkSectionsInputSchema.safeParse(input).success).toBe(false);
    expect(() => chunkSections(input)).toThrow();
  });

  it.each(["数", "𠮷", "😀"])("accepts exactly 1200 code points of %s with identity and full SQLite roundtrip", (character) => withDb(db => {
    const text = character.repeat(1200);
    const input = [section([fact(text)])];
    const before = structuredClone(input);
    const drafts = chunkSections(input);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    if (draft === undefined) throw new Error("missing fact");
    expect(draft.candidate).toMatchObject({ refId: "fact-long", refType: "fact", text, locationKey: "fact:long", sourceVersionId: SOURCE_VERSION_ID });
    expect(draft.blockIds).toEqual(["b-fact"]);
    expect(draft.overlapChars).toBe(0);
    expect(ChunkCandidateSchema.parse(draft.candidate).text).toBe(text);
    replaceChunkSearchRows(db, [rowOf(draft)]);
    expect(db.prepare("SELECT body_text FROM chunk_search").get()).toEqual({ body_text: text });
    expect(searchChunks(db, "事实章节", { schemaVersion: 1 })[0]?.candidate).toEqual(draft.candidate);
    expect(input).toEqual(before);
  }));

  it.each(["数", "𠮷", "😀"])("atomically rejects 1201 code points of %s without changing the source fact", (character) => {
    const input = [section([{ kind: "text", blockId: "good", text: "合法正文" }]), section([fact(character.repeat(1201))])];
    const before = structuredClone(input);
    let generatedRefIds = 0;
    expect(() => chunkSections(input, { makeChunkRefId: () => { generatedRefIds += 1; return "must-not-run"; } })).toThrow();
    expect(generatedRefIds).toBe(0);
    expect(input).toEqual(before);
    const parsed = ChunkSectionsInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("oversized fact was accepted");
    expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "custom", path: [1, "blocks", 0, "text"],
      params: { code: "INDEX_TEXT_TOO_LONG", maxCodePoints: 1200, actualCodePoints: 1201 },
    })]));
  });

  it("all fact parsing entry points reject oversized index text", () => {
    const block = fact("数".repeat(1201));
    const input = section([block]);
    expect(ChunkBlockInputSchema.safeParse(block).success).toBe(false);
    expect(ChunkSectionInputSchema.safeParse(input).success).toBe(false);
    expect(ChunkSectionsInputSchema.safeParse([input]).success).toBe(false);
    expect(() => parseChunkSection(input)).toThrow();
  });

  it.each(["chunk", "fact"] as const)("candidate and derived public schemas enforce the same %s budget", (refType) => {
    const candidate = { ...makeCandidate(), refType, text: "𠮷".repeat(1201) };
    const namespace = makeNamespace();
    const keyword = { schemaVersion: 1 as const, candidate, keywordRank: 1, matchedText: "命中", reason: "测试" };
    const semantic = { schemaVersion: 1, candidate, semanticRank: 1, score: 1, matchedText: "命中", reason: "测试" };
    expect(ChunkCandidateSchema.safeParse(candidate).success).toBe(false);
    expect(ChunkDraftSchema.safeParse({ schemaVersion: 1, candidate, chunkKind: refType === "fact" ? "fact" : "text", contentHash: "a".repeat(64), blockIds: ["b"], overlapChars: 0 }).success).toBe(false);
    expect(KeywordRankedSchema.safeParse(keyword).success).toBe(false);
    expect(SemanticRankedSchema.safeParse(semantic).success).toBe(false);
    expect(EmbeddingRecordSchema.safeParse({ schemaVersion: 1, candidate, namespace, vector: [1, 0, 0] }).success).toBe(false);
    expect(() => filterCandidates([candidate], HardFiltersSchema.parse({ schemaVersion: 1 }))).toThrow(/索引文本/);
    expect(() => cosineRank({ queryVector: [1, 0, 0], queryNamespace: namespace, candidates: [{ schemaVersion: 1, candidate, namespace, vector: [1, 0, 0] }] })).toThrow(/索引文本/);
    expect(() => rrfMerge({ keyword: [keyword], semantic: [], semanticState: { status: "available" } })).toThrow(/索引文本/);
  });

  it.each(["chunk", "fact"] as const)("direct FTS %s accepts 1200 supplementary code points and rejects 1201 before mutation", (refType) => withDb(db => {
    const valid = { ...base, refType, body: "𠮷".repeat(1200) };
    expect(ChunkSearchRowSchema.safeParse(valid).success).toBe(true);
    replaceChunkSearchRows(db, [valid]);
    const invalid = { ...valid, body: "𠮷".repeat(1201) };
    expect(ChunkSearchRowSchema.safeParse(invalid).success).toBe(false);
    expect(() => replaceChunkSearchRows(db, [invalid])).toThrow();
    expect(db.prepare("SELECT chunk_id, body_text FROM chunk_search").all()).toEqual([{ chunk_id: base.chunkId, body_text: valid.body }]);
    expect(searchChunks(db, "𠮷", { schemaVersion: 1 })[0]?.candidate.text).toBe(valid.body);
  }));

  it.each([false, true])("invalid FTS batch is atomic with invalid-first=%s and leaves queries usable", (invalidFirst) => withDb(db => {
    replaceChunkSearchRows(db, [base]);
    const valid = [{ ...base, body: "替换不应落库" }, { ...base, chunkId: "new", body: "新行不应落库" }];
    const invalid = { ...base, refType: "fact" as const, chunkId: "poison", body: "数".repeat(1201) };
    expect(() => replaceChunkSearchRows(db, invalidFirst ? [invalid, ...valid] : [...valid, invalid])).toThrow();
    expect(db.prepare("SELECT chunk_id, body_text FROM chunk_search").all()).toEqual([{ chunk_id: base.chunkId, body_text: base.body }]);
    expect(searchChunks(db, "销售", { schemaVersion: 1 }).map(hit => hit.candidate.refId)).toEqual([base.chunkId]);
    expect(searchChunks(db, "不应落库", { schemaVersion: 1 })).toEqual([]);
  }));

  it.each(["text", "image_context", "table"] as const)("ordinary %s keeps splitting, title, Unicode and provenance", (kind) => {
    const text = "𠮷".repeat(2401);
    const block: ChunkBlockInput = kind === "table"
      ? { kind, blockId: "b-normal", columns: ["列"], rows: [[text]] }
      : kind === "image_context"
        ? { kind, blockId: "b-normal", occurrenceId: OCCURRENCE_ID, text }
        : { kind, blockId: "b-normal", text };
    const input = [section([block])];
    const before = structuredClone(input);
    const drafts = chunkSections(input);
    expect(drafts.length).toBeGreaterThan(1);
    for (const draft of drafts) {
      expect(Array.from(draft.candidate.text).length).toBeLessThanOrEqual(1200);
      expect(draft.candidate.text.startsWith("事实章节\n\n")).toBe(true);
      expect(/[\uD800-\uDFFF]/u.test(draft.candidate.text)).toBe(false);
      expect(draft.blockIds).toEqual(["b-normal"]);
      expect(draft.overlapChars).toBeLessThanOrEqual(100);
      if (kind === "image_context") expect(draft.candidate.occurrenceId).toBe(OCCURRENCE_ID);
    }
    if (kind === "text") expect(drafts.some(draft => draft.overlapChars > 0)).toBe(true);
    expect(input).toEqual(before);
  });
});
