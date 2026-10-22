import {
  type Ast,
  type Block,
  type FieldEdit,
  type ParsedEditOperation,
  type Section,
  type Slide,
} from "@dmall/contracts";
import {
  assertValidAst,
  collectNodeIds,
  collectBlockRefs,
  DomainValidationError,
} from "./ast.js";
import { isFieldChangeLocked, isPathLocked, isSubtreeLocked, lockTree, type LockEntry } from "./authoring-locks.js";

export type EditViolationCode =
  | "UNKNOWN_NODE"
  | "PATH_NOT_ALLOWED"
  | "LOCKED_FIELD"
  | "UNKNOWN_REFERENCE"
  | "CYCLE"
  | "TARGET_TYPE_INVALID";

export interface EditViolation {
  code: EditViolationCode;
  message: string;
  nodeId?: string;
}

export type EditPlan =
  | { ok: true; ast: Ast }
  | { ok: false; violations: EditViolation[] };

export interface EditRules {
  rootNodeId: string;
  actor: "user" | "ai";
  allowedReferenceIds?: ReadonlySet<string>;
}

type OneResult =
  | { ok: true; ast: Ast }
  | { ok: false; violations: EditViolation[] };

export function applyEditOperations(input: {
  ast: Ast;
  operations: ParsedEditOperation[];
  rules: EditRules;
}): EditPlan {
  let ast = structuredClone(input.ast);
  const violations: EditViolation[] = [];

  for (const operation of input.operations) {
    const applied = applyOne(ast, operation, input.rules);
    if (!applied.ok) {
      violations.push(...applied.violations);
      continue;
    }
    ast = applied.ast;
  }

  if (violations.length > 0) return { ok: false, violations };

  try {
    return { ok: true, ast: assertValidAst(ast) };
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return {
        ok: false,
        violations: error.violations.map((item) => ({
          code: item.code === "SCHEMA_INVALID" ? "TARGET_TYPE_INVALID" : "TARGET_TYPE_INVALID",
          message: item.message,
          ...(item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
        })),
      };
    }
    throw error;
  }
}

function applyOne(ast: Ast, operation: ParsedEditOperation, rules: EditRules): OneResult {
  switch (operation.op) {
    case "setField":
      return setField(ast, operation.nodeId, operation, rules);
    case "insertNode":
      return insertNode(ast, operation.parentId, operation, operation.node, rules);
    case "removeNode":
      return removeNode(ast, operation.nodeId, rules);
    case "moveNode":
      return moveNode(ast, operation, rules);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function invalid(code: EditViolationCode, message: string, nodeId?: string): OneResult {
  return {
    ok: false,
    violations: [{ code, message, ...(nodeId === undefined ? {} : { nodeId }) }],
  };
}

function setField(
  ast: Ast,
  nodeId: string,
  field: FieldEdit,
  rules: EditRules,
): OneResult {
  const target = lockTree(ast, rules.rootNodeId).get(nodeId);
  if (target === undefined) return invalid("UNKNOWN_NODE", "找不到操作目标", nodeId);
  if (!isFieldAllowed(target, field.path)) {
    return invalid("PATH_NOT_ALLOWED", `目标不支持字段 ${field.path}`, nodeId);
  }
  if (field.path === "locks" && rules.actor === "ai") {
    return invalid("LOCKED_FIELD", "AI 不能修改锁", nodeId);
  }
  if (!(field.path === "locks" && rules.actor === "user") && (isPathLocked(target, field.path) || isFieldChangeLocked(target, field.path, Reflect.get(target.node, field.path), field.value))) {
    return invalid("LOCKED_FIELD", `字段 ${field.path} 已锁定`, nodeId);
  }
  if (referencesChanged(field, rules.allowedReferenceIds)) {
    return invalid("UNKNOWN_REFERENCE", "修改引用了未提供的素材或事实", nodeId);
  }

  if (target.kind === "root") {
    if (field.path === "title") ast.title = field.value;
    if (field.path === "locks") ast.locks = [...field.value];
    return { ok: true, ast };
  }

  if (target.kind === "section") {
    if (field.path === "title") target.node.title = field.value;
    if (field.path === "locks") target.node.locks = [...field.value];
    if (field.path === "speakerNotes" && ast.kind === "feishu_doc") {
      ast.speakerNotes[target.node.id] = field.value;
    }
    return { ok: true, ast };
  }

  if (target.kind === "slide") {
    if (field.path === "title") target.node.title = field.value;
    if (field.path === "layout") target.node.layout = field.value;
    if (field.path === "speakerNotes") target.node.speakerNotes = field.value;
    if (field.path === "locks") target.node.locks = [...field.value];
    return { ok: true, ast };
  }

  if (!updateBlock(target.node, field)) return invalid("PATH_NOT_ALLOWED", `Block 不支持字段 ${field.path}`, nodeId);
  return { ok: true, ast };
}

function updateBlock(block: Block, field: FieldEdit): boolean {
  if (field.path === "locks") { block.locks = [...field.value]; return true; }
  if (field.path === "provenance") {
    block.provenance = structuredClone(field.value);
    return true;
  }
  if (field.path === "slotId" && block.type !== "readonly_source_block") {
    block.slotId = field.value;
    return true;
  }
  switch (block.type) {
    case "heading":
      if (field.path === "text") { block.text = field.value; return true; }
      if (field.path === "level") { block.level = field.value; return true; }
      return false;
    case "paragraph":
    case "callout":
      if (field.path === "inlines") { block.inlines = structuredClone(field.value); return true; }
      return false;
    case "list":
      if (field.path === "ordered") { block.ordered = field.value; return true; }
      if (field.path === "items") { block.items = structuredClone(field.value); return true; }
      return false;
    case "image":
      if (field.path === "assetVersionId") { block.assetVersionId = field.value; return true; }
      if (field.path === "derivativeId") { block.derivativeId = field.value; return true; }
      if (field.path === "occurrenceId") { block.occurrenceId = field.value; return true; }
      if (field.path === "caption") { block.caption = field.value; return true; }
      if (field.path === "alt") { block.alt = field.value; return true; }
      if (field.path === "fit") { block.fit = field.value; return true; }
      return false;
    case "video":
      if (field.path === "assetVersionId") { block.assetVersionId = field.value; return true; }
      if (field.path === "segmentId") { block.segmentId = field.value; return true; }
      if (field.path === "posterDerivativeId") { block.posterDerivativeId = field.value; return true; }
      if (field.path === "caption") { block.caption = field.value; return true; }
      return false;
    case "table":
      if (field.path === "columns") { block.columns = [...field.value]; return true; }
      if (field.path === "rows") { block.rows = structuredClone(field.value); return true; }
      return false;
    case "divider":
    case "readonly_source_block":
      return false;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function isFieldAllowed(target: LockEntry, path: FieldEdit["path"]): boolean {
  if (target.kind === "root") return path === "title" || path === "locks";
  if (target.kind === "section") {
    return path === "title" || path === "locks" || path === "speakerNotes";
  }
  if (target.kind === "slide") {
    return path === "title" || path === "layout" || path === "speakerNotes" || path === "locks";
  }
  return true;
}

function unknownReferences(ids: string[], allowed: ReadonlySet<string> | undefined): boolean {
  return allowed !== undefined && ids.some((id) => !allowed.has(id));
}

function referencesChanged(field: FieldEdit, allowed: ReadonlySet<string> | undefined): boolean {
  if (allowed === undefined) return false;
  const ids: string[] = [];
  if (
    field.path === "assetVersionId" ||
    field.path === "occurrenceId" ||
    field.path === "posterDerivativeId"
  ) {
    ids.push(field.value);
  }
  if (field.path === "derivativeId" || field.path === "segmentId") {
    if (field.value !== null) ids.push(field.value);
  }
  return unknownReferences(ids, allowed);
}

function insertNode(
  ast: Ast,
  parentId: string,
  operation: Extract<ParsedEditOperation, { op: "insertNode" }>,
  node: Block | Section | Slide,
  rules: EditRules,
): OneResult {
  const parent = lockTree(ast, rules.rootNodeId).get(parentId);
  if (parent === undefined) return invalid("UNKNOWN_NODE", "找不到插入父节点", parentId);
  const ids = new Set([rules.rootNodeId, ...collectNodeIds(ast)]);
  const inserted = isBlock(node) ? [node] : [node, ...node.blocks];
  for (const child of inserted) {
    if (ids.has(child.id)) return invalid("TARGET_TYPE_INVALID", "新子树节点 ID 重复", child.id);
    ids.add(child.id);
  }

  const blocks = isBlock(node) ? [node] : node.blocks;
  if (unknownReferences(blocks.flatMap((block) => collectBlockRefs(block).map((ref) => ref.refId)), rules.allowedReferenceIds)) {
    return invalid("UNKNOWN_REFERENCE", "插入引用了未提供的素材或来源", node.id);
  }
  const childPath = isBlock(node) ? "blocks" : ast.kind === "feishu_doc" ? "sections" : "slides";
  if (isPathLocked(parent, childPath)) return invalid("LOCKED_FIELD", "父容器已锁定，不能插入", parentId);
  if (rules.actor === "ai" && inserted.some(child => child.locks.length > 0)) {
    return invalid("LOCKED_FIELD", "AI 插入的节点不能携带锁", node.id);
  }
  if (isBlock(node)) {
    if (parent.kind !== "section" && parent.kind !== "slide") {
      return invalid("TARGET_TYPE_INVALID", "Block 只能插入章节或页面", parentId);
    }
    const blocks = parent.kind === "section" ? parent.node.blocks : parent.node.blocks;
    return insertAtAnchor(ast, blocks, operation, node);
  }

  if ("layout" in node) {
    if (ast.kind !== "html_deck" || parent.kind !== "root") {
      return invalid("TARGET_TYPE_INVALID", "页面只能插入演示根节点", parentId);
    }
    return insertAtAnchor(ast, ast.slides, operation, node);
  }
  if (ast.kind !== "feishu_doc" || parent.kind !== "root") {
    return invalid("TARGET_TYPE_INVALID", "章节只能插入文档根节点", parentId);
  }
  return insertAtAnchor(ast, ast.sections, operation, node);
}

function removeNode(ast: Ast, nodeId: string, rules: EditRules): OneResult {
  if (nodeId === rules.rootNodeId) {
    return invalid("TARGET_TYPE_INVALID", "不能删除稿件根节点", nodeId);
  }
  const tree = lockTree(ast, rules.rootNodeId);
  const target = tree.get(nodeId);
  if (target === undefined) return invalid("UNKNOWN_NODE", "找不到要删除的节点", nodeId);
  if (isSubtreeLocked(tree, target)) {
    return invalid("LOCKED_FIELD", "节点或后代已锁定，不能删除", nodeId);
  }

  if (ast.kind === "feishu_doc") {
    const sectionIndex = ast.sections.findIndex((section) => section.id === nodeId);
    if (sectionIndex >= 0) {
      const removed = ast.sections.splice(sectionIndex, 1)[0];
      if (removed !== undefined) delete ast.speakerNotes[removed.id];
      return { ok: true, ast };
    }
    for (const section of ast.sections) {
      const index = section.blocks.findIndex((block) => block.id === nodeId);
      if (index >= 0) {
        section.blocks.splice(index, 1);
        return { ok: true, ast };
      }
    }
  } else {
    const slideIndex = ast.slides.findIndex((slide) => slide.id === nodeId);
    if (slideIndex >= 0) {
      ast.slides.splice(slideIndex, 1);
      return { ok: true, ast };
    }
    for (const slide of ast.slides) {
      const index = slide.blocks.findIndex((block) => block.id === nodeId);
      if (index >= 0) {
        slide.blocks.splice(index, 1);
        return { ok: true, ast };
      }
    }
  }
  return invalid("UNKNOWN_NODE", "找不到要删除的节点", nodeId);
}

function moveNode(
  ast: Ast,
  operation: Extract<ParsedEditOperation, { op: "moveNode" }>,
  rules: EditRules,
): OneResult {
  const { nodeId, parentId } = operation;
  if (nodeId === rules.rootNodeId) {
    return invalid("TARGET_TYPE_INVALID", "不能移动稿件根节点", nodeId);
  }
  const anchorId = "beforeId" in operation ? operation.beforeId : operation.afterId;
  if (anchorId === nodeId) return invalid("CYCLE", "不能以移动节点自身作为锚点", nodeId);
  const tree = lockTree(ast, rules.rootNodeId);
  const found = tree.get(nodeId);
  const parent = tree.get(parentId);
  if (found === undefined) return invalid("UNKNOWN_NODE", "找不到要移动的节点", nodeId);
  if (parent === undefined) return invalid("UNKNOWN_NODE", "找不到移动目标父节点", parentId);
  const sourceParent = found.parentId === null ? undefined : tree.get(found.parentId);
  const childPath = found.kind === "block" ? "blocks" : ast.kind === "feishu_doc" ? "sections" : "slides";
  if (
    isSubtreeLocked(tree, found) ||
    (sourceParent !== undefined && isPathLocked(sourceParent, "children")) ||
    isPathLocked(parent, childPath)
  ) {
    return invalid("LOCKED_FIELD", "节点或父容器已锁定，不能移动", nodeId);
  }

  const extracted = extractNode(ast, nodeId);
  if (extracted === null) return invalid("UNKNOWN_NODE", "找不到要移动的节点", nodeId);
  const without = extracted.ast;
  const targetParent = lockTree(without, rules.rootNodeId).get(parentId);
  if (targetParent === undefined) return invalid("CYCLE", "移动会造成循环引用", nodeId);

  let moved: OneResult;
  if (isBlock(extracted.node)) {
    if (targetParent.kind !== "section" && targetParent.kind !== "slide") {
      return invalid("TARGET_TYPE_INVALID", "Block 只能移动到章节或页面", parentId);
    }
    const blocks = targetParent.node.blocks;
    moved = insertAtAnchor(without, blocks, operation, extracted.node);
  } else if ("layout" in extracted.node) {
    if (without.kind !== "html_deck" || targetParent.kind !== "root") {
      return invalid("TARGET_TYPE_INVALID", "页面只能移动到演示根节点", parentId);
    }
    moved = insertAtAnchor(without, without.slides, operation, extracted.node);
  } else {
    if (without.kind !== "feishu_doc" || targetParent.kind !== "root") {
      return invalid("TARGET_TYPE_INVALID", "章节只能移动到文档根节点", parentId);
    }
    moved = insertAtAnchor(without, without.sections, operation, extracted.node);
  }
  if (!moved.ok) return moved;
  const destination = lockTree(moved.ast, rules.rootNodeId);
  const relocated = destination.get(nodeId);
  if (relocated !== undefined && isSubtreeLocked(destination, relocated)) {
    return invalid("LOCKED_FIELD", "目标祖先锁定了移动子树的字段或结构", nodeId);
  }
  return moved;
}

function extractNode(ast: Ast, nodeId: string): { ast: Ast; node: Block | Section | Slide } | null {
  const copy = structuredClone(ast);
  if (copy.kind === "feishu_doc") {
    const sectionIndex = copy.sections.findIndex((section) => section.id === nodeId);
    if (sectionIndex >= 0) {
      const [node] = copy.sections.splice(sectionIndex, 1);
      return node === undefined ? null : { ast: copy, node };
    }
    for (const section of copy.sections) {
      const blockIndex = section.blocks.findIndex((block) => block.id === nodeId);
      if (blockIndex >= 0) {
        const [node] = section.blocks.splice(blockIndex, 1);
        return node === undefined ? null : { ast: copy, node };
      }
    }
  } else {
    const slideIndex = copy.slides.findIndex((slide) => slide.id === nodeId);
    if (slideIndex >= 0) {
      const [node] = copy.slides.splice(slideIndex, 1);
      return node === undefined ? null : { ast: copy, node };
    }
    for (const slide of copy.slides) {
      const blockIndex = slide.blocks.findIndex((block) => block.id === nodeId);
      if (blockIndex >= 0) {
        const [node] = slide.blocks.splice(blockIndex, 1);
        return node === undefined ? null : { ast: copy, node };
      }
    }
  }
  return null;
}

function insertAtAnchor<T extends { id: string }>(
  ast: Ast,
  items: T[],
  operation: { afterId: string | null } | { beforeId: string },
  node: T,
): OneResult {
  const afterId = "afterId" in operation ? operation.afterId : null;
  const beforeId = "beforeId" in operation ? operation.beforeId : null;
  if (beforeId !== null && afterId !== null) {
    return invalid("TARGET_TYPE_INVALID", "beforeId 与 afterId 不能同时出现", beforeId);
  }
  if (afterId !== null && !items.some((item) => item.id === afterId)) {
    return invalid("UNKNOWN_REFERENCE", "afterId 不是同一父容器下的节点", afterId);
  }
  if (beforeId !== null && !items.some((item) => item.id === beforeId)) {
    return invalid("UNKNOWN_REFERENCE", "beforeId 不是同一父容器下的节点", beforeId);
  }
  const index = beforeId !== null
    ? items.findIndex((item) => item.id === beforeId)
    : afterId === null
      ? items.length
      : items.findIndex((item) => item.id === afterId) + 1;
  items.splice(index, 0, node);
  return { ok: true, ast };
}

function isBlock(node: Block | Section | Slide): node is Block {
  return "type" in node;
}
