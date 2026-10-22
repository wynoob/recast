import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseEditOperation,
  type Ast,
  type ParsedEditOperation,
} from "@dmall/contracts";
import {
  applyEditOperations,
  assertValidAst,
  validateAst,
} from "@dmall/domain";

const rootId = randomUUID();
const sectionId = randomUUID();
const paragraphId = randomUUID();
const headingId = randomUUID();

function docAst(): Ast {
  return {
    schemaVersion: 1,
    kind: "feishu_doc",
    title: "原始标题",
    locks: [],
    sections: [
      {
        id: sectionId,
        title: "章节",
        locks: [],
        blocks: [
          {
            id: paragraphId,
            type: "paragraph",
            inlines: [{ text: "原文", marks: [] }],
            provenance: [],
            locks: [],
          },
          {
            id: headingId,
            type: "heading",
            level: 2,
            text: "小标题",
            provenance: [],
            locks: [],
          },
        ],
      },
    ],
    speakerNotes: {},
  };
}

function operation(input: unknown): ParsedEditOperation {
  return parseEditOperation(input);
}

describe("AST domain rules", () => {
  it("applies a legal setField without mutating the input AST", () => {
    const original = assertValidAst(docAst());
    const before = structuredClone(original);
    const result = applyEditOperations({
      ast: original,
      operations: [
        operation({
          op: "setField",
          nodeId: paragraphId,
          path: "inlines",
          value: [{ text: "新正文", marks: [] }],
        }),
      ],
      rules: { rootNodeId: rootId, actor: "user" },
    });
    expect(result.ok).toBe(true);
    expect(original).toEqual(before);
    if (result.ok && result.ast.kind === "feishu_doc") {
      const block = result.ast.sections[0]?.blocks[0];
      expect(block?.type === "paragraph" ? block.inlines[0]?.text : null).toBe("新正文");
    }
  });

  it("accepts slotId body for a deck block", () => {
    const slideId = randomUUID();
    const blockId = randomUUID();
    const ast = assertValidAst({
      schemaVersion: 1,
      kind: "html_deck",
      title: "演示",
      locks: [],
      canvas: { width: 1600, height: 900 },
      slides: [
        {
          id: slideId,
          layout: "title-body-media",
          title: "页",
          blocks: [
            {
              id: blockId,
              type: "paragraph",
              inlines: [{ text: "正文", marks: [] }],
              provenance: [],
              locks: [],
              slotId: "body",
            },
          ],
          speakerNotes: "",
          locks: [],
        },
      ],
    });
    const parsed = operation({
      op: "setField",
      nodeId: blockId,
      path: "slotId",
      value: "body",
    });
    const result = applyEditOperations({
      ast,
      operations: [parsed],
      rules: { rootNodeId: rootId, actor: "user" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects remove, move and insert when the parent section is locked", () => {
    const ast = assertValidAst({
      ...docAst(),
      sections: [
        {
          ...docAst().sections[0]!,
          locks: ["*"],
        },
      ],
    });
    const remove = applyEditOperations({
      ast,
      operations: [operation({ op: "removeNode", nodeId: paragraphId })],
      rules: { rootNodeId: rootId, actor: "user" },
    });
    expect(remove.ok).toBe(false);

    const move = applyEditOperations({
      ast,
      operations: [
        operation({
          op: "moveNode",
          nodeId: headingId,
          parentId: sectionId,
          afterId: null,
        }),
      ],
      rules: { rootNodeId: rootId, actor: "user" },
    });
    expect(move.ok).toBe(false);

    const insert = applyEditOperations({
      ast,
      operations: [
        operation({
          op: "insertNode",
          parentId: sectionId,
          afterId: null,
          node: {
            id: randomUUID(),
            type: "paragraph",
            inlines: [{ text: "新增", marks: [] }],
            provenance: [],
            locks: [],
          },
        }),
      ],
      rules: { rootNodeId: rootId, actor: "user" },
    });
    expect(insert.ok).toBe(false);

    const rootLocked = assertValidAst({ ...docAst(), locks: ["*"] });
    expect(
      applyEditOperations({
        ast: rootLocked,
        operations: [operation({ op: "removeNode", nodeId: sectionId })],
        rules: { rootNodeId: rootId, actor: "user" },
      }).ok,
    ).toBe(false);
    expect(
      applyEditOperations({
        ast: rootLocked,
        operations: [
          operation({ op: "moveNode", nodeId: sectionId, parentId: rootId, afterId: null }),
        ],
        rules: { rootNodeId: rootId, actor: "user" },
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-rectangular table", () => {
    const tableId = randomUUID();
    const result = validateAst({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: "表格",
      locks: [],
      sections: [
        {
          id: randomUUID(),
          title: "章节",
          blocks: [
            {
              id: tableId,
              type: "table",
              columns: ["A", "B"],
              rows: [[[{ text: "只一格", marks: [] }]]],
              provenance: [],
              locks: [],
            },
          ],
          locks: [],
        },
      ],
      speakerNotes: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("TABLE_ROW_LENGTH");
  });

  it("rejects unknown field types at the operation boundary", () => {
    expect(() =>
      operation({
        op: "setField",
        nodeId: paragraphId,
        path: "rawHtml",
        value: "<script>",
      }),
    ).toThrow();
  });

  it("accepts the closed set of ten block types", () => {
    const common = { provenance: [], locks: [] };
    const result = validateAst({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: "九种块",
      locks: [],
      sections: [
        {
          id: randomUUID(),
          title: "章节",
          locks: [],
          blocks: [
            { ...common, id: randomUUID(), type: "heading", level: 1, text: "标题" },
            { ...common, id: randomUUID(), type: "paragraph", inlines: [{ text: "正文", marks: [] }] },
            { ...common, id: randomUUID(), type: "list", ordered: false, items: [[{ text: "条目", marks: [] }]] },
            {
              ...common,
              id: randomUUID(),
              type: "image",
              assetVersionId: randomUUID(),
              derivativeId: null,
              occurrenceId: randomUUID(),
              caption: "",
              alt: "替代文本",
              fit: "contain",
            },
            {
              ...common,
              id: randomUUID(),
              type: "video",
              assetVersionId: randomUUID(),
              segmentId: null,
              posterDerivativeId: randomUUID(),
              caption: "",
            },
            {
              ...common,
              id: randomUUID(),
              type: "table",
              columns: ["列"],
              rows: [[[{ text: "格", marks: [] }]]],
            },
            { ...common, id: randomUUID(), type: "callout", inlines: [{ text: "提示", marks: [] }] },
            { ...common, id: randomUUID(), type: "divider" },
            {
              ...common,
              id: randomUUID(),
              type: "readonly_source_block",
              sourceVersionId: randomUUID(),
              locator: { kind: "page", page: 1 },
              sourceBlockType: "whiteboard",
              sourceUrl: "https://example.com/source",
              summary: "只读来源",
              previewDerivativeId: null,
            },
          ],
        },
      ],
      speakerNotes: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.violations));
    if (result.ast.kind === "feishu_doc") {
      expect(result.ast.sections[0]?.blocks).toHaveLength(9);
    }
  });
});
