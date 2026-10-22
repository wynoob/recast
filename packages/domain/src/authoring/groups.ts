import { createHash } from "node:crypto";
import type {
  Ast,
  AuthoringOperation,
  Block,
  RevisionView,
} from "@dmall/contracts";
import { lockTree } from "../authoring-locks.js";

export type MergeClassification = "automatic" | "satisfied" | "conflict" | "blocked";
export type MergeGroupKind = "field" | "insert" | "remove" | "move" | "mixed";

export interface ComparisonHints {
  candidateAst: Ast | null;
  candidateError: string | null;
}

export interface MergeGroupInput {
  readonly rootNodeId: string;
  readonly base: RevisionView;
  readonly current: RevisionView;
  readonly candidate: { readonly id: string; readonly operations: readonly AuthoringOperation[] };
  readonly targetNodeIds: readonly string[];
  readonly templateValid: boolean;
}

export interface MergeGroup {
  groupId: string;
  classification: MergeClassification;
  kind: MergeGroupKind;
  nodeIds: string[];
  anchors: string[];
  semanticTags: string[];
  operationIndexes: number[];
  operations: AuthoringOperation[];
  baseValue: unknown;
  currentValue: unknown;
  candidateValue: unknown;
  reason: string | null;
  readSet: string[];
  writeSet: string[];
}

export interface OperationEffect {
  reads: Set<string>;
  writes: Set<string>;
  nodeIds: Set<string>;
  anchors: Set<string>;
  semanticTags: Set<string>;
  kind: MergeGroupKind;
}

interface NodeFacts {
  kind: "root" | "section" | "slide" | "block";
  parentId: string | null;
  children: string[];
  value: unknown;
  blockType?: string;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hashHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function buildGroupId(candidateId: string, indexes: readonly number[], tags: readonly string[]): string {
  return `g1:${hashHex({
    candidateId,
    operationIndexes: [...indexes].sort((a, b) => a - b),
    semanticTags: [...new Set(tags)].sort(),
  })}`;
}

export function buildMergeGroups(input: MergeGroupInput): {
  groups: MergeGroup[];
  candidateAst: Ast | null;
  comparison: ComparisonHints;
} {
  const baseIndex = buildNodeFacts(input.base.ast, input.rootNodeId);
  const currentIndex = buildNodeFacts(input.current.ast, input.rootNodeId);
  const effects = input.candidate.operations.map((operation) => operationEffect(operation));
  const parent = effects.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = cursor;
      index = next;
    }
    return cursor;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };

  for (let left = 0; left < effects.length; left += 1) {
    for (let right = left + 1; right < effects.length; right += 1) {
      if (
        intersects(effects[left]!.writes, effects[right]!.reads) ||
        intersects(effects[right]!.writes, effects[left]!.reads) ||
        intersects(effects[left]!.writes, effects[right]!.writes) ||
        sharedContainerSequence(effects[left]!, effects[right]!)
      ) {
        union(left, right);
      }
    }
  }
  const buckets = new Map<number, number[]>();
  effects.forEach((_, index) => {
    const root = find(index);
    const bucket = buckets.get(root) ?? [];
    bucket.push(index);
    buckets.set(root, bucket);
  });

  const groups = [...buckets.values()].map((indexes) => {
    indexes.sort((a, b) => a - b);
    const operations = indexes.map((index) => input.candidate.operations[index]!);
    const tags = [...new Set(indexes.flatMap((index) => [...effects[index]!.semanticTags]))].sort();
    const groupId = buildGroupId(input.candidate.id, indexes, tags);
    const readSet = [...new Set(indexes.flatMap((index) => [...effects[index]!.reads]))].sort();
    const writeSet = [...new Set(indexes.flatMap((index) => [...effects[index]!.writes]))].sort();
    const nodeIds = [...new Set(indexes.flatMap((index) => [...effects[index]!.nodeIds]))].sort();
    const anchors = [...new Set(indexes.flatMap((index) => [...effects[index]!.anchors]))].sort();
    const kind = groupKind(indexes.map((index) => effects[index]!.kind));
    const comparisonKeys = [...new Set([...readSet, ...writeSet])].filter((key) => {
      if (!key.startsWith("node:")) return true;
      return !readSet.some((read) => read.startsWith(`field:${key.slice(5)}:`));
    });
    const baseValue = pickFacts(baseIndex, comparisonKeys);
    const currentValue = pickFacts(currentIndex, comparisonKeys);
    const candidateOutcome = previewGroup(operations, input.base.ast, input.rootNodeId);
    const candidateIndex = candidateOutcome.ast === null
      ? baseIndex
      : buildNodeFacts(candidateOutcome.ast, input.rootNodeId);
    const candidateValue = pickFacts(candidateIndex, comparisonKeys);
    const currentOutcome = previewGroup(operations, input.current.ast, input.rootNodeId);
    const baseUnchanged = canonicalJson(baseValue) === canonicalJson(currentValue);
    const alreadySatisfied = canonicalJson(candidateValue) === canonicalJson(currentValue);

    let classification: MergeClassification = "automatic";
    let reason: string | null = null;
    if (!input.templateValid) {
      classification = "blocked";
      reason = "layout_changed";
    } else if (candidateOutcome.ast === null) {
      classification = "blocked";
      reason = candidateOutcome.error ?? "candidate_invalid";
    } else if (alreadySatisfied) {
      classification = "satisfied";
    } else if (baseUnchanged) {
      classification = "automatic";
    } else if (currentOutcome.ast === null) {
      classification = "conflict";
      reason = conflictReason(groupId, effects, indexes, currentOutcome.error).reason;
    } else {
      const currentAfter = pickFacts(buildNodeFacts(currentOutcome.ast, input.rootNodeId), comparisonKeys);
      classification = canonicalJson(currentAfter) === canonicalJson(currentValue)
        ? "satisfied"
        : "conflict";
      reason = classification === "conflict" ? conflictReason(groupId, effects, indexes, null).reason : null;
    }
    if (!scopeAllowed(writeSet, expandedInsertScope(input.targetNodeIds, operations))) {
      classification = "blocked";
      reason = "target_scope_invalid";
    }
    return {
      groupId,
      classification,
      kind,
      nodeIds,
      anchors,
      semanticTags: tags,
      operationIndexes: indexes,
      operations,
      baseValue,
      currentValue,
      candidateValue,
      reason,
      readSet,
      writeSet,
    } satisfies MergeGroup;
  }).sort((left, right) => left.groupId.localeCompare(right.groupId));

  const candidateAst = previewGroup(input.candidate.operations, input.base.ast, input.rootNodeId).ast;
  return {
    groups,
    candidateAst,
    comparison: {
      candidateAst,
      candidateError: candidateAst === null ? "候选操作无法应用到基线" : null,
    },
  };
}

export function operationEffect(operation: AuthoringOperation): OperationEffect {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const nodeIds = new Set<string>();
  const anchors = new Set<string>();
  const semanticTags = new Set<string>();
  let kind: MergeGroupKind = "field";
  switch (operation.op) {
    case "setField": {
      nodeIds.add(operation.nodeId);
      reads.add(`node:${operation.nodeId}`);
      reads.add(`field:${operation.nodeId}:${operation.path}`);
      writes.add(`field:${operation.nodeId}:${operation.path}`);
      semanticTags.add(semanticTagForField(operation.path));
      break;
    }
    case "insertNode": {
      kind = "insert";
      nodeIds.add(operation.node.id);
      nodeIds.add(operation.parentId);
      reads.add(`children:${operation.parentId}`);
      writes.add(`children:${operation.parentId}`);
      writes.add(`node:${operation.node.id}`);
      const anchor = "beforeId" in operation ? operation.beforeId : operation.afterId;
      if (anchor !== null) {
        anchors.add(anchor);
        reads.add(`node:${anchor}`);
        reads.add(`children:${operation.parentId}`);
      }
      semanticTags.add("structure");
      if ("type" in operation.node) semanticTags.add(`block:${operation.node.type}`);
      break;
    }
    case "removeNode": {
      kind = "remove";
      nodeIds.add(operation.nodeId);
      reads.add(`node:${operation.nodeId}`);
      writes.add(`node:${operation.nodeId}`);
      writes.add(`subtree:${operation.nodeId}`);
      semanticTags.add("structure");
      break;
    }
    case "moveNode": {
      kind = "move";
      nodeIds.add(operation.nodeId);
      nodeIds.add(operation.parentId);
      reads.add(`node:${operation.nodeId}`);
      reads.add(`children:${operation.parentId}`);
      writes.add(`children:${operation.parentId}`);
      writes.add(`subtree:${operation.nodeId}`);
      const anchor = "beforeId" in operation ? operation.beforeId : operation.afterId;
      if (anchor !== null) {
        anchors.add(anchor);
        reads.add(`node:${anchor}`);
      }
      semanticTags.add("structure");
      semanticTags.add("order_changed");
      break;
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
  return { reads, writes, nodeIds, anchors, semanticTags, kind };
}

function previewGroup(
  operations: readonly AuthoringOperation[],
  ast: Ast,
  rootNodeId: string,
): { ast: Ast | null; error: string | null } {
  let next = structuredClone(ast);
  for (const operation of operations) {
    const result = applyOneForGroup(next, operation, rootNodeId);
    if (!result.ok) return { ast: null, error: result.error };
    next = result.ast;
  }
  return { ast: next, error: null };
}

function applyOneForGroup(
  ast: Ast,
  operation: AuthoringOperation,
  rootNodeId: string,
): { ok: true; ast: Ast } | { ok: false; error: string } {
  const tree = lockTree(ast, rootNodeId);
  switch (operation.op) {
    case "setField": {
      const target = tree.get(operation.nodeId);
      if (target === undefined) return { ok: false, error: "unknown_node" };
      if (target.kind === "root") {
        if (operation.path === "title") ast.title = operation.value;
        else return { ok: false, error: "path_not_allowed" };
      } else if (target.kind === "section") {
        if (operation.path === "title") target.node.title = operation.value;
        else if (operation.path === "speakerNotes" && ast.kind === "feishu_doc") ast.speakerNotes[target.node.id] = operation.value;
        else return { ok: false, error: "path_not_allowed" };
      } else if (target.kind === "slide") {
        if (operation.path === "title") target.node.title = operation.value;
        else if (operation.path === "layout") target.node.layout = operation.value;
        else if (operation.path === "speakerNotes") target.node.speakerNotes = operation.value;
        else return { ok: false, error: "path_not_allowed" };
      } else {
        if (!setBlockField(target.node, operation)) return { ok: false, error: "path_not_allowed" };
      }
      return { ok: true, ast };
    }
    case "insertNode": {
      const parent = tree.get(operation.parentId);
      if (parent === undefined && operation.parentId !== rootNodeId) return { ok: false, error: "anchor_missing" };
      if ("type" in operation.node) {
        if (parent === undefined || (parent.kind !== "section" && parent.kind !== "slide")) return { ok: false, error: "target_type_invalid" };
        return insertAt(parent.node.blocks, operation, operation.node, ast);
      }
      if (ast.kind === "feishu_doc" && !("layout" in operation.node)) {
        return insertAt(ast.sections, operation, operation.node, ast);
      }
      if (ast.kind === "html_deck" && "layout" in operation.node) {
        return insertAt(ast.slides, operation, operation.node, ast);
      }
      return { ok: false, error: "target_type_invalid" };
    }
    case "removeNode": {
      if (ast.kind === "feishu_doc") {
        const section = ast.sections.findIndex((item) => item.id === operation.nodeId);
        if (section >= 0) {
          ast.sections.splice(section, 1);
          return { ok: true, ast };
        }
        for (const item of ast.sections) {
          const index = item.blocks.findIndex((block) => block.id === operation.nodeId);
          if (index >= 0) {
            item.blocks.splice(index, 1);
            return { ok: true, ast };
          }
        }
      } else {
        const slide = ast.slides.findIndex((item) => item.id === operation.nodeId);
        if (slide >= 0) {
          ast.slides.splice(slide, 1);
          return { ok: true, ast };
        }
        for (const item of ast.slides) {
          const index = item.blocks.findIndex((block) => block.id === operation.nodeId);
          if (index >= 0) {
            item.blocks.splice(index, 1);
            return { ok: true, ast };
          }
        }
      }
      return { ok: false, error: "delete_edit" };
    }
    case "moveNode": {
      const found = tree.get(operation.nodeId);
      const parent = tree.get(operation.parentId);
      if (found === undefined || parent === undefined) return { ok: false, error: "anchor_missing" };
      const extraction = extract(ast, operation.nodeId);
      if (extraction === null) return { ok: false, error: "unknown_node" };
      const nextTree = lockTree(extraction.ast, rootNodeId);
      const target = nextTree.get(operation.parentId);
      if (target === undefined) return { ok: false, error: "anchor_missing" };
      if ("type" in extraction.node) {
        if (target.kind !== "section" && target.kind !== "slide") return { ok: false, error: "target_type_invalid" };
        return insertAt(target.node.blocks, operation, extraction.node, extraction.ast);
      }
      if (extraction.ast.kind === "feishu_doc") return insertAt(extraction.ast.sections, operation, extraction.node, extraction.ast);
      if (extraction.ast.kind === "html_deck") return insertAt(extraction.ast.slides, operation, extraction.node, extraction.ast);
      return { ok: false, error: "target_type_invalid" };
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function insertAt<T extends { id: string }>(
  items: T[],
  operation: Extract<AuthoringOperation, { op: "insertNode" | "moveNode" }>,
  node: T,
  resultAst: Ast,
): { ok: true; ast: Ast } | { ok: false; error: string } {
  const afterId = "afterId" in operation ? operation.afterId : undefined;
  const beforeId = "beforeId" in operation ? operation.beforeId : undefined;
  if (afterId !== undefined && beforeId !== undefined) return { ok: false, error: "anchor_conflict" };
  let index = items.length;
  if (beforeId !== undefined) {
    index = items.findIndex((item) => item.id === beforeId);
    if (index < 0) return { ok: false, error: "anchor_missing" };
  } else if (afterId !== null && afterId !== undefined) {
    const anchor = items.findIndex((item) => item.id === afterId);
    if (anchor < 0) return { ok: false, error: "anchor_missing" };
    index = anchor + 1;
  }
  items.splice(index, 0, node);
  return { ok: true, ast: resultAst };
}

function extract(ast: Ast, nodeId: string): { ast: Ast; node: Block | import("@dmall/contracts").Section | import("@dmall/contracts").Slide } | null {
  const copy = structuredClone(ast);
  if (copy.kind === "feishu_doc") {
    const index = copy.sections.findIndex((item) => item.id === nodeId);
    if (index >= 0) {
      const [node] = copy.sections.splice(index, 1);
      return node === undefined ? null : { ast: copy, node };
    }
    for (const section of copy.sections) {
      const blockIndex = section.blocks.findIndex((item) => item.id === nodeId);
      if (blockIndex >= 0) {
        const [node] = section.blocks.splice(blockIndex, 1);
        return node === undefined ? null : { ast: copy, node };
      }
    }
  } else {
    const index = copy.slides.findIndex((item) => item.id === nodeId);
    if (index >= 0) {
      const [node] = copy.slides.splice(index, 1);
      return node === undefined ? null : { ast: copy, node };
    }
    for (const slide of copy.slides) {
      const blockIndex = slide.blocks.findIndex((item) => item.id === nodeId);
      if (blockIndex >= 0) {
        const [node] = slide.blocks.splice(blockIndex, 1);
        return node === undefined ? null : { ast: copy, node };
      }
    }
  }
  return null;
}

function setBlockField(block: Block, operation: Extract<AuthoringOperation, { op: "setField" }>): boolean {
  if (operation.path === "locks") {
    block.locks = [...operation.value];
    return true;
  }
  if (operation.path === "provenance") {
    block.provenance = structuredClone(operation.value);
    return true;
  }
  if (operation.path === "slotId") {
    block.slotId = operation.value;
    return true;
  }
  switch (block.type) {
    case "heading":
      if (operation.path === "text") { block.text = operation.value; return true; }
      if (operation.path === "level") { block.level = operation.value; return true; }
      return false;
    case "paragraph":
    case "callout":
      if (operation.path === "inlines") { block.inlines = structuredClone(operation.value); return true; }
      return false;
    case "list":
      if (operation.path === "ordered") { block.ordered = operation.value; return true; }
      if (operation.path === "items") { block.items = structuredClone(operation.value); return true; }
      return false;
    case "image":
      if (operation.path === "assetVersionId") { block.assetVersionId = operation.value; return true; }
      if (operation.path === "derivativeId") { block.derivativeId = operation.value; return true; }
      if (operation.path === "occurrenceId") { block.occurrenceId = operation.value; return true; }
      if (operation.path === "caption") { block.caption = operation.value; return true; }
      if (operation.path === "alt") { block.alt = operation.value; return true; }
      if (operation.path === "fit") { block.fit = operation.value; return true; }
      return false;
    case "video":
      if (operation.path === "assetVersionId") { block.assetVersionId = operation.value; return true; }
      if (operation.path === "segmentId") { block.segmentId = operation.value; return true; }
      if (operation.path === "posterDerivativeId") { block.posterDerivativeId = operation.value; return true; }
      if (operation.path === "caption") { block.caption = operation.value; return true; }
      return false;
    case "table":
      if (operation.path === "columns") { block.columns = [...operation.value]; return true; }
      if (operation.path === "rows") { block.rows = structuredClone(operation.value); return true; }
      return false;
    default:
      return false;
  }
}

function conflictReason(
  _groupId: string,
  effects: readonly OperationEffect[],
  indexes: readonly number[],
  fallback: string | null,
): Pick<MergeGroup, "reason"> & { reason: string } {
  const tags = new Set(indexes.flatMap((index) => [...effects[index]!.semanticTags]));
  if (tags.has("delete_edit")) return { reason: "delete_edit" };
  if (tags.has("order_changed")) return { reason: "order_changed" };
  if (fallback !== null) return { reason: fallback };
  return { reason: "same_field" };
}

function semanticTagForField(path: string): string {
  if (path === "provenance") return "provenance";
  if (["assetVersionId", "derivativeId", "occurrenceId", "segmentId", "posterDerivativeId", "fit", "alt"].includes(path)) return "media";
  if (["columns", "rows"].includes(path)) return "table";
  if (["layout", "slotId"].includes(path)) return "layout";
  return `field:${path}`;
}

function buildNodeFacts(ast: Ast, rootNodeId: string): Map<string, NodeFacts> {
  const map = new Map<string, NodeFacts>();
  const rootChildren = ast.kind === "feishu_doc" ? ast.sections.map((item) => item.id) : ast.slides.map((item) => item.id);
  map.set(rootNodeId, { kind: "root", parentId: null, children: rootChildren, value: ast });
  if (ast.kind === "feishu_doc") {
    for (const section of ast.sections) {
      map.set(section.id, {
        kind: "section",
        parentId: rootNodeId,
        children: section.blocks.map((item) => item.id),
        value: { ...section, speakerNotes: ast.speakerNotes[section.id] ?? "" },
      });
      for (const block of section.blocks) {
        map.set(block.id, { kind: "block", parentId: section.id, children: [], value: block, blockType: block.type });
      }
    }
  } else {
    for (const slide of ast.slides) {
      map.set(slide.id, {
        kind: "slide",
        parentId: rootNodeId,
        children: slide.blocks.map((item) => item.id),
        value: slide,
      });
      for (const block of slide.blocks) {
        map.set(block.id, { kind: "block", parentId: slide.id, children: [], value: block, blockType: block.type });
      }
    }
  }
  return map;
}

function pickFacts(map: Map<string, NodeFacts>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => {
    const [type, id, path] = key.split(":");
    if (type === "children") return [key, map.get(id ?? "")?.children ?? null];
    if (type === "subtree") {
      const facts = map.get(id ?? "");
      return [key, facts === undefined ? null : subtreeFact(map, id ?? "")];
    }
    if (type === "field") {
      const value = map.get(id ?? "")?.value;
      return [key, value !== null && typeof value === "object" ? Reflect.get(value, path ?? "") : null];
    }
    return [key, map.get(id ?? "")?.value ?? null];
  }));
}

function subtreeFact(map: Map<string, NodeFacts>, id: string): unknown {
  const node = map.get(id);
  if (node === undefined) return null;
  return {
    value: node.value,
    children: node.children.map((child) => subtreeFact(map, child)),
  };
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function sharedContainerSequence(left: OperationEffect, right: OperationEffect): boolean {
  for (const key of left.reads) {
    if (key.startsWith("children:") && right.writes.has(key) && right.semanticTags.has("structure")) return true;
  }
  return false;
}

export function expandedInsertScope(
  targetNodeIds: readonly string[],
  operations: readonly AuthoringOperation[],
): string[] {
  if (targetNodeIds.length === 0) return [];
  const scope = new Set(targetNodeIds);
  for (const operation of operations) {
    if (operation.op !== "insertNode" || !scope.has(operation.parentId)) continue;
    scope.add(operation.node.id);
    if (!("type" in operation.node)) {
      for (const block of operation.node.blocks) scope.add(block.id);
    }
  }
  return [...scope];
}

function scopeAllowed(writeSet: readonly string[], targetNodeIds: readonly string[]): boolean {
  if (targetNodeIds.length === 0) return true;
  const scope = new Set(targetNodeIds);
  return writeSet.every((key) => {
    const [, id] = key.split(":");
    return id === undefined || scope.has(id) || key.startsWith("children:");
  });
}

function groupKind(kinds: readonly MergeGroupKind[]): MergeGroupKind {
  const unique = new Set(kinds);
  return unique.size === 1 ? [...unique][0]! : "mixed";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
