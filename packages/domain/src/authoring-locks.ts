import type { Ast, Block, Section, Slide } from "@dmall/contracts";

type LockNode = Ast | Section | Slide | Block;
type Ancestor = { locks: readonly string[]; path: string };
type Location = { parentId: string | null; ancestors: Ancestor[] };
export type LockEntry = Location & (
  | { kind: "root"; node: Ast }
  | { kind: "section"; node: Section; speakerNotes: string | undefined }
  | { kind: "slide"; node: Slide }
  | { kind: "block"; node: Block }
);
export type LockTree = ReadonlyMap<string, LockEntry>;

export function lockTree(ast: Ast, rootNodeId: string): LockTree {
  const tree = new Map<string, LockEntry>();
  tree.set(rootNodeId, { kind: "root", node: ast, parentId: null, ancestors: [] });
  const collection = ast.kind === "feishu_doc" ? "sections" : "slides";
  const addBlocks = (container: Section | Slide) => {
    for (const block of container.blocks) {
      tree.set(block.id, {
        kind: "block", node: block, parentId: container.id,
        ancestors: [
          { locks: ast.locks, path: `${collection}.blocks` },
          { locks: container.locks, path: "blocks" },
        ],
      });
    }
  };
  if (ast.kind === "feishu_doc") {
    for (const node of ast.sections) {
      tree.set(node.id, {
        kind: "section", node, speakerNotes: ast.speakerNotes[node.id], parentId: rootNodeId,
        ancestors: [{ locks: ast.locks, path: collection }],
      });
      addBlocks(node);
    }
  } else {
    for (const node of ast.slides) {
      tree.set(node.id, {
        kind: "slide", node, parentId: rootNodeId,
        ancestors: [{ locks: ast.locks, path: collection }],
      });
      addBlocks(node);
    }
  }
  return tree;
}

export function nodeChildren(node: LockNode): { path: string; nodes: readonly (Section | Slide | Block)[] } | null {
  if ("sections" in node) return { path: "sections", nodes: node.sections };
  if ("slides" in node) return { path: "slides", nodes: node.slides };
  if ("blocks" in node) return { path: "blocks", nodes: node.blocks };
  return null;
}

function protects(locks: readonly string[], path: string): boolean {
  return locks.some(lock => {
    if (lock === "*") return true;
    if (lock === "children") return ["blocks", "sections", "slides"].includes(path.split(".")[0] ?? "");
    const prefix = lock.endsWith(".*") ? lock.slice(0, -2) : lock;
    return path === prefix || path.startsWith(`${prefix}.`);
  });
}

export function isPathLocked(entry: LockEntry, path: string): boolean {
  return protects(entry.node.locks, path)
    || entry.ancestors.some(ancestor => protects(ancestor.locks, `${ancestor.path}.${path}`));
}

function nodeFields(entry: LockEntry): LockNode | (Section & { speakerNotes: string | undefined }) {
  return entry.kind === "section" ? { ...entry.node, speakerNotes: entry.speakerNotes } : entry.node;
}

function readField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" && Object.hasOwn(value, field)
    ? Reflect.get(value, field) : undefined;
}

function keys(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value) : [];
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const fields = keys(left), other = keys(right);
  return fields.length === other.length && fields.every(field => Object.hasOwn(right, field) && equalValue(readField(left, field), readField(right, field)));
}

export function isFieldChangeLocked(entry: LockEntry, path: string, current: unknown, next: unknown): boolean {
  if (equalValue(current, next)) return false;
  if (isPathLocked(entry, path)) return true;
  const fields = new Set([...keys(current), ...keys(next)]);
  return [...fields].some(field => isFieldChangeLocked(entry, `${path}.${field}`, readField(current, field), readField(next, field)));
}

function protectedValue(entry: LockEntry, value: unknown, path: string): boolean {
  return isPathLocked(entry, path)
    || keys(value).some(field => protectedValue(entry, readField(value, field), `${path}.${field}`));
}

export function isSubtreeLocked(tree: LockTree, entry: LockEntry): boolean {
  if (entry.node.locks.length > 0 || (entry.kind === "block" && entry.node.type === "readonly_source_block")) return true;
  const values = nodeFields(entry);
  const children = nodeChildren(entry.node);
  if (keys(values).some(field => field !== "locks" && field !== children?.path && protectedValue(entry, readField(values, field), field))) return true;
  if (children === null) return false;
  return isPathLocked(entry, children.path) || children.nodes.some(child => {
    const target = tree.get(child.id);
    return target !== undefined && isSubtreeLocked(tree, target);
  });
}

export function restoreLockViolation(input: { current: Ast; historical: Ast; rootNodeId: string }): string | null {
  const before = lockTree(input.current, input.rootNodeId), after = lockTree(input.historical, input.rootNodeId);
  for (const [id, entry] of before) {
    const target = after.get(id);
    if (target === undefined) {
      if (isSubtreeLocked(before, entry)) return id;
      continue;
    }
    if (!equalValue(entry.node.locks, target.node.locks)) return id;
    if (entry.parentId !== target.parentId && (isSubtreeLocked(before, entry) || isSubtreeLocked(after, target))) return id;
    const children = nodeChildren(entry.node), targetChildren = nodeChildren(target.node);
    if (children !== null) {
      const ids = children.nodes.map(node => node.id), nextIds = targetChildren?.nodes.map(node => node.id) ?? [];
      if (!equalValue(ids, nextIds) && isPathLocked(entry, children.path)) return id;
      const retained = new Set(nextIds), previous = new Set(ids);
      const oldOrder = ids.filter(childId => retained.has(childId));
      const newOrder = nextIds.filter(childId => previous.has(childId));
      for (const childId of oldOrder) {
        const child = before.get(childId);
        if (child === undefined || !isSubtreeLocked(before, child)) continue;
        const oldIndex = oldOrder.indexOf(childId), newIndex = newOrder.indexOf(childId);
        if (oldOrder.some((sibling, index) => (index < oldIndex) !== (newOrder.indexOf(sibling) < newIndex))) return childId;
      }
    }
    const currentFields = nodeFields(entry), nextFields = nodeFields(target);
    for (const field of new Set([...keys(currentFields), ...keys(nextFields)])) {
      if (["locks", "sections", "slides", "blocks"].includes(field)) continue;
      if (isFieldChangeLocked(entry, field, readField(currentFields, field), readField(nextFields, field))) return id;
    }
    if (entry.kind === "block" && entry.node.type === "readonly_source_block" && !equalValue(entry.node, target.node)) return id;
  }
  return null;
}
