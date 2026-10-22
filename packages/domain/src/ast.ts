import {
  AstSchema,
  BlockSchema,
  type Ast,
  type Block,
  type DeckAst,
  type DocAst,
  type NodeId,
  type Provenance,
  type Section,
  type Slide,
} from "@dmall/contracts";

export type AstViolationCode =
  | "SCHEMA_INVALID"
  | "DUPLICATE_NODE_ID"
  | "TABLE_ROW_LENGTH"
  | "DECK_SLOT_REQUIRED"
  | "DOC_SLOT_NOT_ALLOWED"
  | "TIME_RANGE_INVALID";

export interface AstViolation {
  code: AstViolationCode;
  message: string;
  nodeId?: string;
}

export type AstValidation =
  | { ok: true; ast: Ast }
  | { ok: false; violations: AstViolation[] };

export class DomainValidationError extends Error {
  readonly violations: AstViolation[];

  constructor(violations: AstViolation[]) {
    super(violations[0]?.message ?? "稿件结构无效");
    this.name = "DomainValidationError";
    this.violations = violations;
  }
}

export function validateAst(input: unknown): AstValidation {
  const parsed = AstSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      violations: [
        {
          code: "SCHEMA_INVALID",
          message: parsed.error.issues[0]?.message ?? "稿件结构不符合 AST schema",
        },
      ],
    };
  }

  const violations = collectViolations(parsed.data);
  return violations.length === 0 ? { ok: true, ast: parsed.data } : { ok: false, violations };
}

export function assertValidAst(input: unknown): Ast {
  const result = validateAst(input);
  if (!result.ok) throw new DomainValidationError(result.violations);
  return result.ast;
}

function collectViolations(ast: Ast): AstViolation[] {
  const violations: AstViolation[] = [];
  const ids = new Set<string>();

  const addId = (id: string): void => {
    if (ids.has(id)) {
      violations.push({ code: "DUPLICATE_NODE_ID", message: "节点 ID 重复", nodeId: id });
    }
    ids.add(id);
  };

  const validateBlock = (block: Block, deck: boolean): void => {
    addId(block.id);
    if (deck && block.slotId === undefined) {
      violations.push({
        code: "DECK_SLOT_REQUIRED",
        message: "演示 Block 必须声明 slotId，未放置时使用 null",
        nodeId: block.id,
      });
    }
    if (!deck && block.slotId !== undefined) {
      violations.push({
        code: "DOC_SLOT_NOT_ALLOWED",
        message: "文档 Block 不应声明 slotId",
        nodeId: block.id,
      });
    }
    if (block.type === "table") {
      for (const [index, row] of block.rows.entries()) {
        if (row.length !== block.columns.length) {
          violations.push({
            code: "TABLE_ROW_LENGTH",
            message: `第 ${index + 1} 行单元格数与列数不一致`,
            nodeId: block.id,
          });
        }
      }
    }
    validateProvenance(block.provenance, block.id, violations);
  };

  if (ast.kind === "feishu_doc") {
    for (const section of ast.sections) {
      addId(section.id);
      for (const block of section.blocks) validateBlock(block, false);
    }
  } else {
    for (const slide of ast.slides) {
      addId(slide.id);
      for (const block of slide.blocks) validateBlock(block, true);
    }
  }

  return violations;
}

function validateProvenance(
  provenance: Provenance[],
  nodeId: string,
  violations: AstViolation[],
): void {
  for (const item of provenance) {
    if (item.kind === "source" && item.locator.kind === "time") {
      if (item.locator.startMs >= item.locator.endMs) {
        violations.push({
          code: "TIME_RANGE_INVALID",
          message: "时间定位必须满足 startMs < endMs",
          nodeId,
        });
      }
    }
  }
}

export function collectNodeIds(ast: Ast): string[] {
  const ids: string[] = [];
  if (ast.kind === "feishu_doc") {
    for (const section of ast.sections) {
      ids.push(section.id, ...section.blocks.map((block) => block.id));
    }
  } else {
    for (const slide of ast.slides) {
      ids.push(slide.id, ...slide.blocks.map((block) => block.id));
    }
  }
  return ids;
}

export interface RevisionRef {
  refType:
    | "source_version"
    | "fact_version"
    | "message"
    | "asset_version"
    | "occurrence"
    | "derivative"
    | "segment"
    | "template_version";
  refId: string;
}

export function deriveRevisionRefs(input: {
  ast: Ast;
  templateVersionId: string | null;
}): RevisionRef[] {
  const refs = new Map<string, RevisionRef>();
  const add = (refType: RevisionRef["refType"], refId: string): void => {
    refs.set(`${refType}:${refId}`, { refType, refId });
  };

  if (input.templateVersionId !== null) add("template_version", input.templateVersionId);

  const blocks =
    input.ast.kind === "feishu_doc"
      ? input.ast.sections.flatMap((section) => section.blocks)
      : input.ast.slides.flatMap((slide) => slide.blocks);

  for (const block of blocks) {
    for (const ref of collectBlockRefs(block)) add(ref.refType, ref.refId);
  }

  return [...refs.values()];
}

export function collectBlockRefs(block: Block): RevisionRef[] {
  const refs: RevisionRef[] = [];
  const add = (refType: RevisionRef["refType"], refId: string): void => {
    refs.push({ refType, refId });
  };
    for (const item of block.provenance) {
      if (item.kind === "source") add("source_version", item.sourceVersionId);
      if (item.kind === "fact") add("fact_version", item.factVersionId);
      if (item.kind === "user_assertion") add("message", item.messageId);
    }
    switch (block.type) {
      case "image":
        add("asset_version", block.assetVersionId);
        add("occurrence", block.occurrenceId);
        if (block.derivativeId !== null) add("derivative", block.derivativeId);
        break;
      case "video":
        add("asset_version", block.assetVersionId);
        add("derivative", block.posterDerivativeId);
        if (block.segmentId !== null) add("segment", block.segmentId);
        break;
      case "readonly_source_block":
        add("source_version", block.sourceVersionId);
        if (block.previewDerivativeId !== null) add("derivative", block.previewDerivativeId);
        break;
      default:
        break;
    }
  return refs;
}

export type ContainerNode =
  | { kind: "root"; ast: Ast; rootNodeId: string }
  | { kind: "section"; ast: DocAst; section: Section }
  | { kind: "slide"; ast: DeckAst; slide: Slide }
  | { kind: "block"; block: Block; parentLocks: string[] };

export function findContainer(
  ast: Ast,
  nodeId: NodeId | string,
  rootNodeId?: string,
): ContainerNode | null {
  if (rootNodeId !== undefined && nodeId === rootNodeId) {
    return { kind: "root", ast, rootNodeId };
  }
  if (ast.kind === "feishu_doc") {
    for (const section of ast.sections) {
      if (section.id === nodeId) return { kind: "section", ast, section };
      for (const block of section.blocks) {
        if (block.id === nodeId) return { kind: "block", block, parentLocks: section.locks };
      }
    }
  } else {
    for (const slide of ast.slides) {
      if (slide.id === nodeId) return { kind: "slide", ast, slide };
      for (const block of slide.blocks) {
        if (block.id === nodeId) return { kind: "block", block, parentLocks: slide.locks };
      }
    }
  }
  return null;
}

export function parseBlock(input: unknown): Block {
  return BlockSchema.parse(input);
}
