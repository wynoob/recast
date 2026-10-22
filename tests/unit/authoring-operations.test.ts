import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEditOperation, type Ast } from "@dmall/contracts";
import { applyEditOperations, assertValidAst } from "@dmall/domain";

function doc(input: {
  rootLocks?: string[];
  sectionLocks?: string[];
  blockLocks?: string[];
} = {}): { ast: Ast; rootId: string; sectionId: string; firstId: string; secondId: string } {
  const rootId = randomUUID();
  const sectionId = randomUUID();
  const firstId = randomUUID();
  const secondId = randomUUID();
  return {
    rootId,
    sectionId,
    firstId,
    secondId,
    ast: assertValidAst({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: "锁与锚点",
      locks: input.rootLocks ?? [],
      speakerNotes: {},
      sections: [{
        id: sectionId,
        title: "章节",
        locks: input.sectionLocks ?? [],
        blocks: [
          {
            id: firstId,
            type: "paragraph",
            inlines: [{ text: "第一段", marks: [] }],
            provenance: [],
            locks: input.blockLocks ?? [],
          },
          {
            id: secondId,
            type: "paragraph",
            inlines: [{ text: "第二段", marks: [] }],
            provenance: [],
            locks: [],
          },
        ],
      }],
    }),
  };
}

function apply(ast: Ast, rootId: string, operation: unknown, actor: "user" | "ai" = "user") {
  return applyEditOperations({
    ast,
    operations: [parseEditOperation(operation)],
    rules: { rootNodeId: rootId, actor, allowedReferenceIds: new Set<string>() },
  });
}

function block(text: string) {
  return {
    id: randomUUID(),
    type: "paragraph" as const,
    inlines: [{ text, marks: [] }],
    provenance: [],
    locks: [],
  };
}

describe("authoring anchors and effective locks", () => {
  it("inserts before the first child and keeps afterId:null append semantics", () => {
    const sample = doc();
    const before = block("首位");
    const prepended = apply(sample.ast, sample.rootId, {
      op: "insertNode",
      parentId: sample.sectionId,
      beforeId: sample.firstId,
      node: before,
    });
    expect(prepended.ok).toBe(true);
    if (prepended.ok && prepended.ast.kind === "feishu_doc") {
      expect(prepended.ast.sections[0]?.blocks.map((item) => item.id)).toEqual([
        before.id,
        sample.firstId,
        sample.secondId,
      ]);
    }

    const appended = apply(sample.ast, sample.rootId, {
      op: "insertNode",
      parentId: sample.sectionId,
      afterId: null,
      node: block("末尾"),
    });
    expect(appended.ok).toBe(true);
    if (appended.ok && appended.ast.kind === "feishu_doc") {
      expect(appended.ast.sections[0]?.blocks.at(-1)?.id).not.toBe(sample.firstId);
    }
  });

  it("moves with beforeId and rejects a self anchor", () => {
    const sample = doc();
    const moved = apply(sample.ast, sample.rootId, {
      op: "moveNode",
      nodeId: sample.secondId,
      parentId: sample.sectionId,
      beforeId: sample.firstId,
    });
    expect(moved.ok).toBe(true);
    if (moved.ok && moved.ast.kind === "feishu_doc") {
      expect(moved.ast.sections[0]?.blocks.map((item) => item.id)).toEqual([
        sample.secondId,
        sample.firstId,
      ]);
    }
    expect(apply(sample.ast, sample.rootId, {
      op: "moveNode",
      nodeId: sample.secondId,
      parentId: sample.sectionId,
      beforeId: sample.secondId,
    })).toMatchObject({ ok: false, violations: [{ code: "CYCLE" }] });
  });

  it("does not use an unrelated locked sibling to simulate first insert", () => {
    const sample = doc({ blockLocks: ["*"] });
    expect(apply(sample.ast, sample.rootId, {
      op: "moveNode",
      nodeId: sample.firstId,
      parentId: sample.sectionId,
      beforeId: sample.secondId,
    })).toMatchObject({ ok: false, violations: [{ code: "LOCKED_FIELD" }] });
  });

  it("checks source and target parent locks for moves", () => {
    const sample = doc({ sectionLocks: ["children"] });
    expect(apply(sample.ast, sample.rootId, {
      op: "moveNode",
      nodeId: sample.secondId,
      parentId: sample.sectionId,
      beforeId: sample.firstId,
    })).toMatchObject({ ok: false, violations: [{ code: "LOCKED_FIELD" }] });
  });

  it("rejects anchors that are not siblings and AI insertion carrying locks", () => {
    const sample = doc();
    expect(apply(sample.ast, sample.rootId, {
      op: "insertNode",
      parentId: sample.sectionId,
      beforeId: randomUUID(),
      node: block("无锚点"),
    })).toMatchObject({ ok: false, violations: [{ code: "UNKNOWN_REFERENCE" }] });
    expect(apply(sample.ast, sample.rootId, {
      op: "insertNode",
      parentId: sample.sectionId,
      afterId: null,
      node: { ...block("带锁"), locks: ["*"] },
    }, "ai")).toMatchObject({ ok: false, violations: [{ code: "LOCKED_FIELD" }] });
  });

  it("rejects body edits on a readonly source block", () => {
    const sourceId = randomUUID();
    const blockId = randomUUID();
    const rootId = randomUUID();
    const sectionId = randomUUID();
    const ast = assertValidAst({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: "只读",
      locks: [],
      speakerNotes: {},
      sections: [{
        id: sectionId,
        title: "章节",
        locks: [],
        blocks: [{
          id: blockId,
          type: "readonly_source_block",
          sourceVersionId: sourceId,
          locator: { kind: "page", page: 1 },
          sourceBlockType: "whiteboard",
          sourceUrl: "https://example.com/source",
          summary: "摘要",
          previewDerivativeId: null,
          provenance: [],
          locks: [],
        }],
      }],
    });
    expect(apply(ast, rootId, {
      op: "setField",
      nodeId: blockId,
      path: "inlines",
      value: [],
    })).toMatchObject({ ok: false, violations: [{ code: "PATH_NOT_ALLOWED" }] });
  });

  it("checks locked descendants on move and remove", () => {
    const slideId = randomUUID();
    const childId = randomUUID();
    const secondSlideId = randomUUID();
    const rootId = randomUUID();
    const ast = assertValidAst({
      schemaVersion: 1,
      kind: "html_deck",
      title: "演示",
      locks: [],
      canvas: { width: 1600, height: 900 },
      slides: [
        {
          id: slideId,
          layout: "cover",
          title: "一",
          speakerNotes: "",
          locks: [],
          blocks: [{
            id: childId,
            type: "paragraph",
            inlines: [{ text: "锁住", marks: [] }],
            provenance: [],
            locks: ["*"],
            slotId: "body",
          }],
        },
        {
          id: secondSlideId,
          layout: "cover",
          title: "二",
          speakerNotes: "",
          locks: [],
          blocks: [],
        },
      ],
    });
    expect(apply(ast, rootId, {
      op: "moveNode",
      nodeId: slideId,
      parentId: rootId,
      afterId: secondSlideId,
    }).ok).toBe(false);
    expect(apply(ast, rootId, {
      op: "removeNode",
      nodeId: slideId,
    })).toMatchObject({ ok: false, violations: [{ code: "LOCKED_FIELD" }] });
  });

  it("does not mutate the input AST or reuse its object graph", () => {
    const sample = doc();
    const before = structuredClone(sample.ast);
    const result = apply(sample.ast, sample.rootId, {
      op: "setField",
      nodeId: sample.firstId,
      path: "inlines",
      value: [{ text: "改写", marks: [] }],
    });
    expect(result.ok).toBe(true);
    expect(sample.ast).toEqual(before);
  });
});
