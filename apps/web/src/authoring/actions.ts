import type {
  Ast,
  AuthoringOperation,
  Block,
  DocAst,
  Section,
  Slide,
} from "@dmall/contracts";
import { applyEditOperations } from "@dmall/domain/operations";

export function applyLocalOperations(ast: Ast, operations: AuthoringOperation[], rootNodeId: string): Ast {
  if (operations.length === 0) return ast;
  const result = applyEditOperations({
    ast,
    operations,
    rules: {
      rootNodeId,
      actor: "user",
    },
  });
  if (!result.ok) {
    throw new Error(result.violations[0]?.message ?? "操作无法应用");
  }
  return result.ast;
}

export function rootNodeId(ast: Ast): string {
  const candidates = ast.kind === "feishu_doc"
    ? ast.sections.map((section) => section.id)
    : ast.slides.map((slide) => slide.id);
  return candidates[0] ?? (ast.kind === "feishu_doc" ? "doc-root" : "deck-root");
}

export function createSection(): Section {
  return {
    id: crypto.randomUUID(),
    title: "新章节",
    blocks: [],
    locks: [],
  };
}

export function newBlock(type: "paragraph" | "heading" | "callout" | "divider" | "list" | "table"): Block {
  const base = {
    id: crypto.randomUUID(),
    provenance: [],
    locks: [],
  };
  if (type === "heading") return { ...base, type, level: 2, text: "" };
  if (type === "paragraph") return { ...base, type, inlines: [{ text: "", marks: [] }] };
  if (type === "callout") return { ...base, type, inlines: [{ text: "", marks: [] }] };
  if (type === "list") return { ...base, type, ordered: false, items: [[{ text: "", marks: [] }]] };
  if (type === "table") {
    return {
      ...base,
      type,
      columns: ["列 1", "列 2"],
      rows: [[[{ text: "", marks: [] }], [{ text: "", marks: [] }]]],
    };
  }
  return { ...base, type };
}

export function findSlide(ast: Ast, nodeId: string): Slide | null {
  return ast.kind === "html_deck" ? ast.slides.find((slide) => slide.id === nodeId) ?? null : null;
}

export function findSection(ast: Ast, nodeId: string): Section | null {
  return ast.kind === "feishu_doc" ? ast.sections.find((section) => section.id === nodeId) ?? null : null;
}

export function findBlock(ast: Ast, nodeId: string): { block: Block; parentId: string } | null {
  if (ast.kind === "feishu_doc") {
    for (const section of ast.sections) {
      const block = section.blocks.find((item) => item.id === nodeId);
      if (block !== undefined) return { block, parentId: section.id };
    }
  } else {
    for (const slide of ast.slides) {
      const block = slide.blocks.find((item) => item.id === nodeId);
      if (block !== undefined) return { block, parentId: slide.id };
    }
  }
  return null;
}

export function operationForInlines(nodeId: string, inlines: import("@dmall/contracts").Inlines): AuthoringOperation {
  return { op: "setField", nodeId, path: "inlines", value: inlines };
}

export function insertOperationAtEnd(parentId: string, node: Section | Slide | Block): AuthoringOperation {
  return {
    op: "insertNode",
    parentId,
    afterId: null,
    node,
  };
}

export function docAst(ast: Ast): DocAst {
  if (ast.kind !== "feishu_doc") throw new Error("不是文档 AST");
  return ast;
}

export function diffAst(before: Ast, after: Ast, rootNodeId: string): AuthoringOperation[] {
  if (before.kind !== after.kind) throw new Error("不能在同一修订内切换稿件格式");
  const operations: AuthoringOperation[] = [];
  if (before.title !== after.title) {
    operations.push({ op: "setField", nodeId: rootNodeId, path: "title", value: after.title });
  }
  if (before.kind === "feishu_doc" && after.kind === "feishu_doc") {
    diffSections(before, after, rootNodeId, operations);
  }
  if (before.kind === "html_deck" && after.kind === "html_deck") {
    diffSlides(before, after, rootNodeId, operations);
  }
  return operations;
}

function diffSections(before: DocAst, after: DocAst, rootNodeId: string, operations: AuthoringOperation[]): void {
  const beforeIds = new Set(before.sections.map((section) => section.id));
  const afterIds = new Set(after.sections.map((section) => section.id));
  for (const section of before.sections) {
    if (!afterIds.has(section.id)) operations.push({ op: "removeNode", nodeId: section.id });
  }
  for (const section of after.sections) {
    if (!beforeIds.has(section.id)) {
      operations.push({ op: "insertNode", parentId: rootNodeId, afterId: null, node: section });
    }
  }
  for (const section of after.sections) {
    const old = before.sections.find((item) => item.id === section.id);
    if (old === undefined) continue;
    diffContainerFields(old, section, operations);
    diffBlocks(old.blocks, section.blocks, section.id, operations);
    if ((before.speakerNotes[section.id] ?? "") !== (after.speakerNotes[section.id] ?? "")) {
      operations.push({
        op: "setField",
        nodeId: section.id,
        path: "speakerNotes",
        value: after.speakerNotes[section.id] ?? "",
      });
    }
  }
  diffOrder(
    before.sections.map((item) => item.id),
    after.sections.map((item) => item.id),
    rootNodeId,
    operations,
  );
}

function diffSlides(
  before: import("@dmall/contracts").DeckAst,
  after: import("@dmall/contracts").DeckAst,
  rootNodeId: string,
  operations: AuthoringOperation[],
): void {
  const beforeIds = new Set(before.slides.map((slide) => slide.id));
  const afterIds = new Set(after.slides.map((slide) => slide.id));
  for (const slide of before.slides) {
    if (!afterIds.has(slide.id)) operations.push({ op: "removeNode", nodeId: slide.id });
  }
  for (const slide of after.slides) {
    if (!beforeIds.has(slide.id)) {
      operations.push({ op: "insertNode", parentId: rootNodeId, afterId: null, node: slide });
    }
  }
  for (const slide of after.slides) {
    const old = before.slides.find((item) => item.id === slide.id);
    if (old === undefined) continue;
    diffContainerFields(old, slide, operations);
    diffBlocks(old.blocks, slide.blocks, slide.id, operations);
  }
  diffOrder(
    before.slides.map((item) => item.id),
    after.slides.map((item) => item.id),
    rootNodeId,
    operations,
  );
}

function diffContainerFields(
  before: Section | Slide,
  after: Section | Slide,
  operations: AuthoringOperation[],
): void {
  if (before.title !== after.title) {
    operations.push({ op: "setField", nodeId: after.id, path: "title", value: after.title });
  }
  if (JSON.stringify(before.locks) !== JSON.stringify(after.locks)) {
    operations.push({ op: "setField", nodeId: after.id, path: "locks", value: after.locks });
  }
  if ("layout" in after && "layout" in before && before.layout !== after.layout) {
    operations.push({ op: "setField", nodeId: after.id, path: "layout", value: after.layout });
  }
  if ("speakerNotes" in after && "speakerNotes" in before && before.speakerNotes !== after.speakerNotes) {
    operations.push({ op: "setField", nodeId: after.id, path: "speakerNotes", value: after.speakerNotes });
  }
}

function diffBlocks(before: Block[], after: Block[], parentId: string, operations: AuthoringOperation[]): void {
  const beforeIds = new Set(before.map((block) => block.id));
  const afterIds = new Set(after.map((block) => block.id));
  for (const block of before) {
    if (!afterIds.has(block.id)) operations.push({ op: "removeNode", nodeId: block.id });
  }
  for (const block of after) {
    if (!beforeIds.has(block.id)) {
      operations.push({ op: "insertNode", parentId, afterId: null, node: block });
    }
  }
  for (const block of after) {
    const old = before.find((item) => item.id === block.id);
    if (old === undefined) continue;
    diffBlockFields(old, block, operations);
  }
  diffOrder(before.map((block) => block.id), after.map((block) => block.id), parentId, operations);
}

function diffBlockFields(before: Block, after: Block, operations: AuthoringOperation[]): void {
  if (before.locks.length !== after.locks.length ||
    before.locks.some((lock, index) => lock !== after.locks[index])) {
    operations.push({ op: "setField", nodeId: after.id, path: "locks", value: after.locks });
  }
  if (JSON.stringify(before.provenance) !== JSON.stringify(after.provenance)) {
    operations.push({ op: "setField", nodeId: after.id, path: "provenance", value: after.provenance });
  }
  if (before.slotId !== after.slotId) {
    operations.push({ op: "setField", nodeId: after.id, path: "slotId", value: after.slotId ?? null });
  }
  const paths = blockComparableFields(after);
  for (const path of paths) {
    const left = Reflect.get(before, path);
    const right = Reflect.get(after, path);
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      operations.push({ op: "setField", nodeId: after.id, path, value: right } as AuthoringOperation);
    }
  }
}

function blockComparableFields(block: Block): Array<
  "text" | "level" | "inlines" | "ordered" | "items" | "assetVersionId" |
  "derivativeId" | "occurrenceId" | "caption" | "alt" | "fit" | "segmentId" |
  "posterDerivativeId" | "columns" | "rows"
> {
  switch (block.type) {
    case "heading": return ["text", "level"];
    case "paragraph":
    case "callout": return ["inlines"];
    case "list": return ["ordered", "items"];
    case "image": return ["assetVersionId", "derivativeId", "occurrenceId", "caption", "alt", "fit"];
    case "video": return ["assetVersionId", "segmentId", "posterDerivativeId", "caption"];
    case "table": return ["columns", "rows"];
    default: return [];
  }
}

function diffOrder(
  beforeIds: readonly string[],
  afterIds: readonly string[],
  parentId: string,
  operations: AuthoringOperation[],
): void {
  const afterSet = new Set(afterIds);
  const working = beforeIds.filter((id) => afterSet.has(id));
  for (const id of afterIds) if (!working.includes(id)) working.push(id);
  for (let index = 0; index < afterIds.length; index += 1) {
    const desired = afterIds[index]!;
    if (working[index] === desired) continue;
    const currentIndex = working.indexOf(desired);
    if (currentIndex < 0) continue;
    const anchor = working[index] ?? null;
    operations.push(anchor === null
      ? { op: "moveNode", nodeId: desired, parentId, afterId: null }
      : { op: "moveNode", nodeId: desired, parentId, beforeId: anchor });
    working.splice(currentIndex, 1);
    working.splice(index, 0, desired);
  }
}
