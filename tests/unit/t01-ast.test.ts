import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEditOperation, BlockSchema } from "@dmall/contracts";
import { assertValidAst, applyEditOperations } from "@dmall/domain";

const root = randomUUID(), section = randomUUID(), paragraph = randomUUID(), other = randomUUID();
function document(locks: string[] = [], blockLocks: string[] = []) {
  return assertValidAst({ schemaVersion: 1, kind: "feishu_doc", title: "稿件", locks: [], speakerNotes: {}, sections: [
    { id: section, title: "章节", locks, blocks: [{ id: paragraph, type: "paragraph", inlines: [], locks: blockLocks, provenance: [] }] },
    { id: other, title: "第二章", locks: [], blocks: [] },
  ] });
}
function apply(ast: ReturnType<typeof document>, operation: unknown, actor: "user" | "ai" = "ai", allowed = new Set<string>()) {
  return applyEditOperations({ ast, operations: [parseEditOperation(operation)], rules: { rootNodeId: root, actor, allowedReferenceIds: allowed } });
}
const block = () => ({ id: randomUUID(), type: "paragraph", inlines: [], locks: [], provenance: [] });

describe("T01 AST protection", () => {
  it.each([paragraph, section])("rejects deleting locked fields through node %s", (nodeId) => {
    expect(apply(document([], ["inlines"]), { op: "removeNode", nodeId })).toMatchObject({ ok: false, violations: [{ code: "LOCKED_FIELD" }] });
  });

  it.each(["*", "blocks", "blocks.*", "children"])("uses the same container protection for %s", (lock) => {
    const ast = document([lock]);
    for (const operation of [
      { op: "insertNode", parentId: section, afterId: null, node: block() },
      { op: "removeNode", nodeId: paragraph },
      { op: "moveNode", nodeId: paragraph, parentId: other, afterId: null },
      { op: "setField", nodeId: paragraph, path: "inlines", value: [{ text: "改写", marks: [] }] },
    ]) expect(apply(ast, operation)).toMatchObject({ ok: false, violations: [{ code: "LOCKED_FIELD" }] });
    const source = document();
    if (source.kind !== "feishu_doc") throw new Error("doc required");
    const destination = source.sections[1];
    if (destination === undefined) throw new Error("destination required");
    destination.locks = [lock];
    expect(apply(source, { op: "moveNode", nodeId: paragraph, parentId: other, afterId: null }).ok).toBe(false);
  });

  it("keeps an ancestor title lock local to that field", () => {
    expect(apply(document(["title"]), { op: "setField", nodeId: paragraph, path: "inlines", value: [] }).ok).toBe(true);
  });

  it("allows explicit user unlock even under a whole-node lock and rejects AI unlock", () => {
    const operation = { op: "setField", nodeId: paragraph, path: "locks", value: [] };
    expect(apply(document(["*"], ["*"]), operation, "user").ok).toBe(true);
    expect(apply(document(["*"], ["*"]), operation, "ai").ok).toBe(false);
    expect(apply(document(), { ...operation, value: ["inlines"] }, "user").ok).toBe(true);
  });

  it("validates every inserted media, source and provenance reference in nested containers", () => {
    const refs = Array.from({ length: 10 }, () => randomUUID());
    const [asset, occurrence, derivative, segment, poster, source, preview, fact, message, provenanceSource] = refs;
    const common = () => ({ id: randomUUID(), locks: [], provenance: [] });
    const blocks = [
      { ...common(), type: "image", assetVersionId: asset, occurrenceId: occurrence, derivativeId: derivative, caption: "", alt: "", fit: "contain" },
      { ...common(), type: "video", assetVersionId: asset, segmentId: segment, posterDerivativeId: poster, caption: "" },
      { ...common(), type: "readonly_source_block", sourceVersionId: source, previewDerivativeId: preview, locator: { kind: "page", page: 1 }, sourceBlockType: "whiteboard", sourceUrl: "https://example.com", summary: "" },
      { ...block(), provenance: [{ kind: "fact", factVersionId: fact }, { kind: "user_assertion", messageId: message }, { kind: "source", sourceVersionId: provenanceSource, locator: { kind: "page", page: 1 } }] },
    ];
    const operation = { op: "insertNode", parentId: root, afterId: null, node: { id: randomUUID(), title: "引用章", locks: [], blocks } };
    const used = refs.slice(0, 10);
    expect(apply(document(), operation, "ai", new Set(used)).ok).toBe(true);
    for (const missing of used) {
      expect(apply(document(), operation, "ai", new Set(used.filter(id => id !== missing)))).toMatchObject({ ok: false, violations: [{ code: "UNKNOWN_REFERENCE" }] });
    }
  });

  it("rejects quote and keeps the wire field shape", () => {
    expect(BlockSchema.safeParse({ ...block(), type: "quote" }).success).toBe(false);
    expect(parseEditOperation({ op: "setField", nodeId: root, path: "title", value: "标题" })).toEqual({ op: "setField", nodeId: root, path: "title", value: "标题" });
  });

  it("allows inserting the first slide into a blank deck", () => {
    const ast = assertValidAst({ schemaVersion: 1, kind: "html_deck", title: "空稿", locks: [], canvas: { width: 1600, height: 900 }, slides: [] });
    expect(apply(ast, { op: "insertNode", parentId: root, afterId: null, node: { id: randomUUID(), layout: "cover", title: "第一页", speakerNotes: "", locks: [], blocks: [] } }).ok).toBe(true);
  });
});
