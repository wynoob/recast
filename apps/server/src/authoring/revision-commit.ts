import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AstSchema,
  LocatorSchema,
  VideoProbeSchema,
  RevisionEvidenceSchema,
  RevisionRefSchema,
  FixedEvidenceSchema,
  RevisionRecordSchema,
  type RevisionRecord,
  type Ast,
  type Block,
  type AuthoringOperation,
  type Claim,
  type OccurrenceBinding,
  type Provenance,
  type Locator,
  type RevisionEvidence,
  type RevisionRef,
  type RevisionRefType,
  type FixedEvidence,
} from "@dmall/contracts";
import {
  applyEditOperations,
  restoreLockViolation,
  assertValidAst,
  collectBlockRefs,
  collectNodeIds,
  deriveRevisionRefs,
  type EditViolation,
} from "@dmall/domain";
import { evidenceEntityHash, evidenceIndexTextHash } from "./evidence-hash.js";

export type CommitErrorCode =
  | "REVISION_CONFLICT"
  | "LOCKED_FIELD"
  | "UNKNOWN_REFERENCE"
  | "AST_INVALID"
  | "REFERENCE_HISTORY_UNRESOLVED"
  | "INDEX_TEXT_TOO_LONG"
  | "VALIDATION_ERROR";

export class RevisionCommitError extends Error {
  readonly code: CommitErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CommitErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RevisionCommitError";
    this.code = code;
    this.details = details;
  }
}

type BaseCommit = {
  readonly reason: string;
};

export type CommitRevisionInput =
  | (BaseCommit & {
      readonly mode: "first_revision";
      readonly contentId: string;
      readonly renditionId: string;
      readonly rootNodeId: string;
      readonly ast: Ast;
      readonly templateVersionId: null;
      readonly createdBy: "user" | "import";
      readonly expectedCurrentRevisionId: null;
    })
  | (BaseCommit & {
      readonly mode: "derive_initial";
      readonly contentId: string;
      readonly renditionId: string;
      readonly rootNodeId: string;
      readonly ast: Ast;
      readonly templateVersionId: null;
      readonly createdBy: "user";
      readonly expectedCurrentRevisionId: null;
    })
  | (BaseCommit & {
      readonly mode: "manual";
      readonly renditionId: string;
      readonly baseRevisionId: string;
      readonly operations: readonly AuthoringOperation[];
      readonly claims: readonly Claim[];
      readonly evidenceSelections: readonly string[];
      readonly fixedEvidence: readonly FixedEvidence[];
      readonly createdBy: "user";
      readonly expectedCurrentRevisionId: string;
    })
  | (BaseCommit & {
      readonly mode: "candidate_accept";
      readonly renditionId: string;
      readonly candidateId: string;
      readonly ast: Ast;
      readonly claims: readonly Claim[];
      readonly fixedEvidence: readonly FixedEvidence[];
      readonly createdBy: "ai_accepted";
      readonly expectedCurrentRevisionId: string;
    })
  | (BaseCommit & {
      readonly mode: "restore";
      readonly renditionId: string;
      readonly historicalRevisionId: string;
      readonly createdBy: "restore";
      readonly expectedCurrentRevisionId: string;
    });

export type CommitRevisionResult = {
  readonly revisionId: string;
};

export type CommitBoundary = "revision" | "refs" | "evidence" | "cas";

const RenditionRowSchema = z.strictObject({
  id: z.uuid(),
  content_id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  root_node_id: z.uuid(),
  current_revision_id: z.uuid().nullable(),
});

const RevisionRowSchema = z.strictObject({
  id: z.uuid(),
  rendition_id: z.uuid(),
  parent_id: z.uuid().nullable(),
  template_version_id: z.uuid().nullable(),
  ast_json: z.string(),
  created_by: z.enum(["user", "ai_accepted", "feishu_pull", "restore", "import"]),
  reason: z.string(),
  created_at: z.string(),
});

const EvidenceRowSchema = z.strictObject({
  revision_id: z.uuid(),
  schema_version: z.int(),
  direct_refs_json: z.string(),
  transitive_refs_json: z.string(),
  blob_hashes_json: z.string(),
  bindings_json: z.string(),
  binding_hash: z.string(),
  created_at: z.string(),
});

const OccurrenceRowSchema = z.strictObject({
  id: z.uuid(),
  source_version_id: z.uuid(),
  asset_id: z.uuid().nullable(),
  locator_json: z.string(),
  canonical_id: z.uuid().nullable(),
  version: z.int().nonnegative(),
});

const AssetRowSchema = z.strictObject({
  id: z.uuid(),
  blob_hash: z.string(),
  media_kind: z.enum(["image", "gif", "video"]),
});

const DerivativeRowSchema = z.strictObject({
  id: z.uuid(),
  asset_id: z.uuid(),
  blob_hash: z.string(),
});

const SegmentRowSchema = z.strictObject({
  id: z.uuid(),
  asset_id: z.uuid(),
  start_ms: z.int().nonnegative(),
  end_ms: z.int(),
  derivative_id: z.uuid().nullable(),
});

const TemplateRowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
});

const MessageRowSchema = z.strictObject({ id: z.uuid(), role: z.string(), content_id: z.uuid() });
const SourceVersionBlobRowSchema = z.strictObject({
  id: z.uuid(),
  snapshot_blob_hash: z.string(),
});

type RenditionRow = z.infer<typeof RenditionRowSchema>;
type RevisionRow = z.infer<typeof RevisionRowSchema>;
type OccurrenceRow = z.infer<typeof OccurrenceRowSchema>;

type ClosureContext = {
  readonly contentId: string;
  readonly ast: Ast;
  readonly templateVersionId: string | null;
  readonly fixedEvidence?: readonly FixedEvidence[];
};

export function insertRevisionRecord(db: Database.Database, record: RevisionRecord): void {
  if (!db.inTransaction) throw new Error("修订记录必须在事务内写入");
  const parsed = RevisionRecordSchema.parse(record);
  db.prepare(
    `INSERT INTO revisions
      (id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.id, parsed.renditionId, parsed.parentId, parsed.templateVersionId,
    JSON.stringify(parsed.ast), parsed.createdBy, parsed.reason, parsed.createdAt,
  );
}

export function commitRevision(
  db: Database.Database,
  input: CommitRevisionInput,
  onBoundary?: (boundary: CommitBoundary) => void,
): CommitRevisionResult {
  if (!db.inTransaction) {
    throw new Error("commitRevision 必须在事务内调用");
  }

  const rendition = requireRendition(db, input.renditionId);
  if ("contentId" in input && input.contentId !== rendition.content_id) {
    throw new RevisionCommitError("VALIDATION_ERROR", "内容与稿件分支不匹配");
  }
  if ("rootNodeId" in input && input.rootNodeId !== rendition.root_node_id) {
    throw new RevisionCommitError("VALIDATION_ERROR", "根节点与稿件分支不匹配");
  }

  const currentId = rendition.current_revision_id;
  assertExpectedCurrent(input, currentId);

  const prepared = prepareCommit(db, rendition, input);
  const now = new Date().toISOString();
  const revisionId = randomUUID();

  insertRevisionRecord(db, {
    schemaVersion: 1,
    id: revisionId,
    renditionId: rendition.id,
    parentId: prepared.parentId,
    templateVersionId: prepared.templateVersionId,
    ast: prepared.ast,
    createdBy: input.createdBy,
    reason: input.reason,
    createdAt: now,
  });
  onBoundary?.("revision");

  const insertRef = db.prepare(
    "INSERT INTO revision_refs(revision_id, ref_type, ref_id) VALUES (?, ?, ?)",
  );
  for (const ref of prepared.evidence.directRefs) {
    insertRef.run(revisionId, ref.refType, ref.refId);
  }
  onBoundary?.("refs");

  db.prepare(
    `INSERT INTO revision_evidence
      (revision_id, schema_version, direct_refs_json, transitive_refs_json, blob_hashes_json, bindings_json, binding_hash, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    JSON.stringify(prepared.evidence.directRefs),
    JSON.stringify(prepared.evidence.transitiveRefs),
    JSON.stringify(prepared.evidence.blobHashes),
    JSON.stringify(prepared.evidence.bindings),
    prepared.evidence.bindingHash,
    now,
  );
  onBoundary?.("evidence");

  const insertFixed = db.prepare(
    `INSERT INTO revision_fixed_evidence(
      revision_id, evidence_id, kind, entity_json, entity_hash, index_text_hash, binding_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const evidence of prepared.fixedEvidence) {
    insertFixed.run(
      revisionId,
      evidence.evidenceId,
      evidence.kind,
      JSON.stringify(evidence),
      evidenceEntityHash(evidence),
      evidenceIndexTextHash(evidence),
      "bindingHash" in evidence
        ? evidence.bindingHash ?? evidenceEntityHash(evidence)
        : evidenceEntityHash(evidence),
      now,
    );
  }

  const updated = prepared.templateVersionId === null && prepared.parentId === null
    ? db.prepare(
        `UPDATE renditions
         SET current_revision_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND current_revision_id IS NULL`,
      ).run(revisionId, now, rendition.id)
    : db.prepare(
        `UPDATE renditions
         SET current_revision_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND current_revision_id = ?`,
      ).run(revisionId, now, rendition.id, prepared.expectedCurrentRevisionId);
  if (updated.changes !== 1) {
    throw revisionConflict(rendition.id, currentId);
  }
  onBoundary?.("cas");

  return { revisionId };
}

function assertExpectedCurrent(input: CommitRevisionInput, currentId: string | null): void {
  if (input.expectedCurrentRevisionId !== currentId) {
    throw revisionConflict(input.renditionId, currentId);
  }
  if (input.mode === "first_revision" || input.mode === "derive_initial") {
    if (currentId !== null) {
      throw revisionConflict(input.renditionId, currentId);
    }
  }
  if (input.mode === "manual" && input.baseRevisionId !== currentId) {
    throw revisionConflict(input.renditionId, currentId);
  }
}

function revisionConflict(renditionId: string, currentRevisionId: string | null): RevisionCommitError {
  return new RevisionCommitError("REVISION_CONFLICT", "稿件已被其他操作修改", {
    renditionId,
    currentRevisionId,
  });
}

function prepareCommit(
  db: Database.Database,
  rendition: RenditionRow,
  input: CommitRevisionInput,
): {
  ast: Ast;
  parentId: string | null;
  templateVersionId: string | null;
  expectedCurrentRevisionId: string | null;
  evidence: RevisionEvidence;
  fixedEvidence: FixedEvidence[];
} {
  if (input.mode === "first_revision" || input.mode === "derive_initial") {
    if (input.templateVersionId !== null) {
      throw new RevisionCommitError("VALIDATION_ERROR", "首修订不能固定模板版本");
    }
    const ast = assertAst(input.ast);
    if (ast.kind !== rendition.kind) {
      throw new RevisionCommitError("AST_INVALID", "稿件类型与分支类型不一致");
    }
    return {
      ast,
      parentId: null,
      templateVersionId: null,
      expectedCurrentRevisionId: null,
      evidence: buildClosure(db, { contentId: rendition.content_id, ast, templateVersionId: null }),
      fixedEvidence: [],
    };
  }

  if (input.mode === "manual") {
    assertUnlockBatch(input.operations);
    const base = requireRevision(db, input.baseRevisionId, rendition.id);
    const baseAst = parseAstRow(base.ast_json);
    const baseEvidence = historicalEvidence(db, base.id, baseAst, base.template_version_id);
    const fixedEvidence = mergeFixedEvidence(
      loadFixedEvidence(db, base.id),
      validateFixedEvidence(input.fixedEvidence, input.evidenceSelections),
    );
    assertFixedEvidenceForAst(baseAst, base.template_version_id, fixedEvidence);
    validateClaims(baseAst, input.claims, fixedEvidence);
    const allowed = referenceIdsInAstAndOperations(baseAst, input.operations);
    const result = applyEditOperations({
      ast: baseAst,
      operations: [...input.operations],
      rules: {
        rootNodeId: rendition.root_node_id,
        actor: "user",
        allowedReferenceIds: allowed,
      },
    });
    if (!result.ok) throw editRejection(result.violations);
    const ast = assertAst(result.ast);
    if (ast.kind !== rendition.kind) {
      throw new RevisionCommitError("AST_INVALID", "稿件类型与分支类型不一致");
    }
    return {
      ast,
      parentId: rendition.current_revision_id,
      templateVersionId: base.template_version_id,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      evidence: buildClosure(db, {
        contentId: rendition.content_id,
        ast,
        templateVersionId: base.template_version_id,
        fixedEvidence,
      }, { ast: baseAst, evidence: baseEvidence }),
      fixedEvidence,
    };
  }

  if (input.mode === "candidate_accept") {
    const ast = assertAst(input.ast);
    if (ast.kind !== rendition.kind) {
      throw new RevisionCommitError("AST_INVALID", "候选稿类型与分支类型不一致");
    }
    const current = rendition.current_revision_id === null
      ? null
      : requireRevision(db, rendition.current_revision_id, rendition.id);
    const fixedEvidence = mergeFixedEvidence(
      current === null ? [] : loadFixedEvidence(db, current.id),
      validateFixedEvidence(input.fixedEvidence, []),
    );
    if (current !== null) assertFixedEvidenceForAst(parseAstRow(current.ast_json), current.template_version_id, fixedEvidence);
    validateClaims(ast, input.claims, fixedEvidence);
    const currentAst = current === null ? null : parseAstRow(current.ast_json);
    const candidate = queryOne(
      db,
      z.strictObject({ rendition_id: z.uuid(), template_version_id: z.uuid().nullable() }),
      "SELECT rendition_id, template_version_id FROM ai_candidates WHERE id = ?",
      input.candidateId,
    );
    if (candidate === null || candidate.rendition_id !== rendition.id) {
      throw new RevisionCommitError("VALIDATION_ERROR", "候选不属于当前稿件分支");
    }
    const templateVersionId = candidate.template_version_id;
    return {
      ast,
      parentId: current?.id ?? null,
      templateVersionId,
      expectedCurrentRevisionId: current?.id ?? null,
      evidence: buildClosure(db, {
        contentId: rendition.content_id,
        ast,
        templateVersionId,
        fixedEvidence,
      }, currentAst === null ? undefined : {
        ast: currentAst,
        evidence: historicalEvidence(db, current!.id, currentAst, current!.template_version_id),
      }),
      fixedEvidence,
    };
  }

  const historical = requireRevision(db, input.historicalRevisionId, rendition.id);
  const ast = parseAstRow(historical.ast_json);
  const evidence = historicalEvidence(db, historical.id, ast, historical.template_version_id);
  const fixedEvidence = loadFixedEvidence(db, historical.id);
  assertFixedEvidenceForAst(ast, historical.template_version_id, fixedEvidence);
  const current = rendition.current_revision_id === null
    ? null
    : requireRevision(db, rendition.current_revision_id, rendition.id);
  const currentAst = current === null ? null : parseAstRow(current.ast_json);
  if (currentAst !== null) {
    const lockedNodeId = restoreLockViolation({ current: currentAst, historical: ast, rootNodeId: rendition.root_node_id });
    if (lockedNodeId !== null) throw new RevisionCommitError("LOCKED_FIELD", "恢复会覆盖当前锁定字段或结构", { nodeId: lockedNodeId });
  }
  return {
    ast,
    parentId: rendition.current_revision_id,
    templateVersionId: historical.template_version_id,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    evidence,
    fixedEvidence,
  };
}

function loadFixedEvidence(db: Database.Database, revisionId: string): FixedEvidence[] {
  const rows = z.array(z.strictObject({
    entity_json: z.string(),
  })).parse(db.prepare(
    "SELECT entity_json FROM revision_fixed_evidence WHERE revision_id = ? ORDER BY evidence_id",
  ).all(revisionId));
  return rows.map((row) => FixedEvidenceSchema.parse(JSON.parse(row.entity_json) as unknown));
}

function mergeFixedEvidence(base: readonly FixedEvidence[], additions: readonly FixedEvidence[]): FixedEvidence[] {
  const merged = new Map(base.map((item) => [item.evidenceId, item]));
  for (const item of additions) merged.set(item.evidenceId, item);
  return [...merged.values()];
}

function assertFixedEvidenceForAst(
  ast: Ast,
  templateVersionId: string | null,
  fixedEvidence: readonly FixedEvidence[],
): void {
  const factIds = new Set(
    deriveRevisionRefs({ ast, templateVersionId })
      .filter((ref) => ref.refType === "fact_version")
      .map((ref) => ref.refId),
  );
  const bound = new Set(
    fixedEvidence
      .filter((item): item is Extract<FixedEvidence, { kind: "fact" }> => item.kind === "fact")
      .map((item) => item.entity.factVersionId),
  );
  for (const factId of factIds) {
    if (!bound.has(factId)) {
      throw new RevisionCommitError(
        "REFERENCE_HISTORY_UNRESOLVED",
        "修订引用了缺少完整 FactEntity 固定的历史事实",
        { factVersionId: factId },
      );
    }
  }
}

function assertUnlockBatch(operations: readonly AuthoringOperation[]): void {
  const unlock = operations.length > 0 && operations.every(
    (operation) => operation.op === "setField" && operation.path === "locks",
  );
  if (operations.some((operation) => operation.op === "setField" && operation.path === "locks") && !unlock) {
    throw new RevisionCommitError(
      "VALIDATION_ERROR",
      "人工解锁必须在只包含 locks setField 的独立批次中提交",
    );
  }
}

function validateFixedEvidence(
  fixedEvidence: readonly FixedEvidence[],
  evidenceSelections: readonly string[],
): FixedEvidence[] {
  const parsed = fixedEvidence.map((item) => FixedEvidenceSchema.parse(item));
  const ids = new Set<string>();
  for (const item of parsed) {
    if (ids.has(item.evidenceId)) {
      throw new RevisionCommitError("VALIDATION_ERROR", "固定证据 ID 重复", {
        evidenceId: item.evidenceId,
      });
    }
    ids.add(item.evidenceId);
    if (item.kind === "fact") {
      if (item.entity.indexText.codePoints > 1_200 || Array.from(item.entity.indexText.text).length > 1_200) {
        throw new RevisionCommitError("INDEX_TEXT_TOO_LONG", "事实索引文本超过 1200 码点");
      }
      if (sha256(item.entity.indexText.text) !== item.entity.indexText.textHash) {
        throw new RevisionCommitError("UNKNOWN_REFERENCE", "事实索引文本 hash 不一致");
      }
    }
  }
  for (const selection of evidenceSelections) {
    if (!ids.has(selection)) {
      throw new RevisionCommitError("UNKNOWN_REFERENCE", "证据选择未提供固定实体", {
        evidenceId: selection,
      });
    }
  }
  return parsed;
}

function validateClaims(ast: Ast, claims: readonly Claim[], evidence: readonly FixedEvidence[]): void {
  if (claims.length === 0) return;
  const nodeIds = new Set(collectNodeIds(ast));
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  for (const claim of claims) {
    if (!nodeIds.has(claim.nodeId)) {
      throw new RevisionCommitError("UNKNOWN_REFERENCE", "claim 指向不存在的节点", {
        nodeId: claim.nodeId,
      });
    }
    if (claim.kind === "fact") {
      const matched = evidence.some((item) =>
        item.kind === "fact" &&
        (item.evidenceId === claim.factEvidenceId || item.entity.factVersionId === claim.factEvidenceId));
      if (!matched) {
        throw new RevisionCommitError("UNKNOWN_REFERENCE", "事实 claim 缺少完整 FactEntity", {
          evidenceId: claim.factEvidenceId,
        });
      }
    }
    if (claim.kind === "source_interpretation") {
      for (const id of claim.evidenceIds) {
        if (evidenceById.get(id)?.kind !== "source" && evidenceById.get(id)?.kind !== "fact") {
          throw new RevisionCommitError("UNKNOWN_REFERENCE", "解释 claim 的来源证据不存在", {
            evidenceId: id,
          });
        }
      }
    }
    if (claim.kind === "user_assertion") {
      const fixed = evidenceById.get(claim.evidenceId);
      if (fixed?.kind !== "user_assertion" || fixed.textHash !== claim.textHash) {
        throw new RevisionCommitError("UNKNOWN_REFERENCE", "用户陈述 claim 的证据或文本 hash 不一致");
      }
    }
  }
}

function editRejection(violations: readonly EditViolation[]): RevisionCommitError {
  const first = violations[0];
  const code = first?.code === "LOCKED_FIELD"
    ? "LOCKED_FIELD"
    : first?.code === "UNKNOWN_REFERENCE"
      ? "UNKNOWN_REFERENCE"
      : first?.code === "UNKNOWN_NODE" || first?.code === "PATH_NOT_ALLOWED" || first?.code === "TARGET_TYPE_INVALID"
        ? "VALIDATION_ERROR"
        : "AST_INVALID";
  return new RevisionCommitError(code, first?.message ?? "修订操作无效", { violations });
}

function assertAst(input: unknown): Ast {
  try {
    return assertValidAst(input);
  } catch (error) {
    throw new RevisionCommitError("AST_INVALID", "稿件 AST 无效", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireRendition(db: Database.Database, renditionId: string): RenditionRow {
  const row = db.prepare(
    `SELECT id, content_id, kind, root_node_id, current_revision_id
     FROM renditions WHERE id = ?`,
  ).get(renditionId);
  if (row === undefined) {
    throw new RevisionCommitError("VALIDATION_ERROR", "稿件分支不存在");
  }
  return RenditionRowSchema.parse(row);
}

function requireRevision(db: Database.Database, revisionId: string, renditionId: string): RevisionRow {
  const row = db.prepare(
    `SELECT id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at
     FROM revisions WHERE id = ?`,
  ).get(revisionId);
  if (row === undefined) {
    throw new RevisionCommitError("VALIDATION_ERROR", "修订不存在");
  }
  const parsed = RevisionRowSchema.parse(row);
  if (parsed.rendition_id !== renditionId) {
    throw new RevisionCommitError("VALIDATION_ERROR", "修订不属于目标稿件分支");
  }
  return parsed;
}

function parseAstRow(value: string): Ast {
  try {
    return assertAst(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof RevisionCommitError) throw error;
    throw new RevisionCommitError("AST_INVALID", "历史修订 AST 无法读取");
  }
}

function referenceIdsInAstAndOperations(
  ast: Ast,
  operations: readonly AuthoringOperation[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const ref of deriveRevisionRefs({ ast, templateVersionId: null })) ids.add(ref.refId);
  for (const operation of operations) {
    if (operation.op === "setField" && ["assetVersionId", "derivativeId", "occurrenceId", "segmentId", "posterDerivativeId"].includes(operation.path) && typeof operation.value === "string") {
      ids.add(operation.value);
    }
    if (operation.op === "setField" && operation.path === "provenance") {
      for (const item of operation.value) {
        if (item.kind === "source") ids.add(item.sourceVersionId);
        if (item.kind === "fact") ids.add(item.factVersionId);
        if (item.kind === "user_assertion") ids.add(item.messageId);
      }
    }
    if (operation.op === "insertNode") {
      const blocks = "type" in operation.node
        ? [operation.node]
        : operation.node.blocks;
      for (const block of blocks) {
        for (const ref of collectBlockRefs(block)) ids.add(ref.refId);
      }
    }
  }
  return ids;
}

type ReferenceRelation =
  | ({ kind: "image" } & Pick<Extract<Block, { type: "image" }>, "assetVersionId" | "occurrenceId" | "derivativeId">)
  | ({ kind: "video" } & Pick<Extract<Block, { type: "video" }>, "assetVersionId" | "segmentId" | "posterDerivativeId">)
  | ({ kind: "readonly_source_block" } & Pick<Extract<Block, { type: "readonly_source_block" }>, "sourceVersionId" | "locator" | "previewDerivativeId">)
  | Provenance
  | { kind: "template"; templateVersionId: string };

function referenceRelations(ast: Ast, templateVersionId: string | null): ReferenceRelation[] {
  const relations: ReferenceRelation[] = [];
  if (templateVersionId !== null) relations.push({ kind: "template", templateVersionId });
  const blocks = ast.kind === "feishu_doc"
    ? ast.sections.flatMap(section => section.blocks)
    : ast.slides.flatMap(slide => slide.blocks);
  for (const block of blocks) {
    relations.push(...block.provenance);
    if (block.type === "image") relations.push({ kind: "image", assetVersionId: block.assetVersionId, occurrenceId: block.occurrenceId, derivativeId: block.derivativeId });
    if (block.type === "video") relations.push({ kind: "video", assetVersionId: block.assetVersionId, segmentId: block.segmentId, posterDerivativeId: block.posterDerivativeId });
    if (block.type === "readonly_source_block") relations.push({ kind: "readonly_source_block", sourceVersionId: block.sourceVersionId, locator: block.locator, previewDerivativeId: block.previewDerivativeId });
  }
  return relations;
}

function buildClosure(
  db: Database.Database,
  input: ClosureContext,
  base?: { ast: Ast; evidence: RevisionEvidence },
): RevisionEvidence {
  const refs = dedupeRefs(deriveRevisionRefs({ ast: input.ast, templateVersionId: input.templateVersionId }));
  const relations = referenceRelations(input.ast, input.templateVersionId);
  const inheritedTemplateVersionId = base?.evidence.directRefs.find(ref => ref.refType === "template_version")?.refId ?? null;
  const inheritedRelations = new Set(base === undefined ? [] : referenceRelations(base.ast, inheritedTemplateVersionId).map(stableJson));
  const finalRelations = new Set(relations.map(stableJson));
  const retainsBase = base !== undefined && [...inheritedRelations].every(relation => finalRelations.has(relation));
  if (retainsBase && [...finalRelations].every(relation => inheritedRelations.has(relation))) return base.evidence;
  const transitive = dedupeRefs([...refs, ...(retainsBase ? base.evidence.transitiveRefs : [])]);
  const blobs = new Set<string>(retainsBase ? base.evidence.blobHashes : []);
  const bindings = new Map<string, OccurrenceBinding>(retainsBase ? base.evidence.bindings.map(binding => [binding.requestedOccurrenceId, binding]) : []);
  for (const relation of relations) {
    const inherited = inheritedRelations.has(stableJson(relation)) ? base?.evidence : undefined;
    if (inherited !== undefined && retainsBase) continue;
    const relationBlobs = new Set<string>();
    switch (relation.kind) {
      case "template": {
        const template = queryOne(db, TemplateRowSchema, "SELECT id, kind FROM template_versions WHERE id = ?", relation.templateVersionId);
        if (template === null || template.kind !== input.ast.kind) throw unknownReference({ refType: "template_version", refId: relation.templateVersionId });
        break;
      }
      case "image": {
        const asset = requireAssetVersion(db, relation.assetVersionId);
        if (asset.media_kind === "video") throw unknownReference({ refType: "asset_version", refId: relation.assetVersionId });
        relationBlobs.add(asset.blob_hash);
        let binding: OccurrenceBinding;
        if (inherited !== undefined) {
          const fixed = inherited.bindings.find(item => item.requestedOccurrenceId === relation.occurrenceId);
          if (fixed === undefined || fixed.assetIdAtCapture !== asset.id) throw unresolvedHistory("图片历史绑定缺失或与素材不匹配");
          binding = fixed;
        } else {
          const occurrence = queryOne(db, OccurrenceRowSchema,
            "SELECT id, source_version_id, asset_id, locator_json, canonical_id, version FROM occurrences WHERE id = ?", relation.occurrenceId);
          if (occurrence === null || occurrence.asset_id !== asset.id) throw unknownReference({ refType: "occurrence", refId: relation.occurrenceId });
          const captured = new Map<string, OccurrenceBinding>();
          addBinding(captured, occurrence);
          const fixed = captured.get(occurrence.id);
          if (fixed === undefined) throw unknownReference({ refType: "occurrence", refId: relation.occurrenceId });
          binding = fixed;
        }
        const existing = bindings.get(binding.requestedOccurrenceId);
        if (existing !== undefined && stableJson(existing) !== stableJson(binding)) {
          throw new RevisionCommitError("UNKNOWN_REFERENCE", "同一 occurrence 的新旧关系绑定不一致");
        }
        bindings.set(binding.requestedOccurrenceId, binding);
        addRef(transitive, "source_version", binding.sourceVersionId);
        relationBlobs.add(requireSourceBlob(db, binding.sourceVersionId));
        if (relation.derivativeId !== null) {
          requireAssetChild(db, relation.derivativeId, asset.id, "derivative");
          relationBlobs.add(requireDerivative(db, relation.derivativeId).blob_hash);
        }
        break;
      }
      case "video": {
        const asset = requireAssetVersion(db, relation.assetVersionId);
        if (asset.media_kind !== "video") throw unknownReference({ refType: "asset_version", refId: relation.assetVersionId });
        relationBlobs.add(asset.blob_hash);
        requireAssetChild(db, relation.posterDerivativeId, asset.id, "derivative");
        relationBlobs.add(requireDerivative(db, relation.posterDerivativeId).blob_hash);
        if (relation.segmentId !== null) {
          requireAssetChild(db, relation.segmentId, asset.id, "segment");
          const segment = queryOne(db, SegmentRowSchema, "SELECT id, asset_id, start_ms, end_ms, derivative_id FROM segments WHERE id = ?", relation.segmentId);
          if (segment === null) throw unknownReference({ refType: "segment", refId: relation.segmentId });
          if (inherited === undefined) {
            const metadata = z.object({ metadata_json: z.string() }).parse(db.prepare("SELECT metadata_json FROM asset_versions WHERE id = ?").get(relation.assetVersionId));
            const probe = z.object({ probe: VideoProbeSchema }).safeParse(JSON.parse(metadata.metadata_json) as unknown);
            if (!probe.success || segment.start_ms >= segment.end_ms || segment.end_ms > probe.data.probe.durationMs) {
              throw unknownReference({ refType: "segment", refId: relation.segmentId });
            }
          }
          if (segment.derivative_id !== null) {
            requireAssetChild(db, segment.derivative_id, asset.id, "derivative");
            addRef(transitive, "derivative", segment.derivative_id);
            relationBlobs.add(requireDerivative(db, segment.derivative_id).blob_hash);
          }
        }
        break;
      }
      case "source":
      case "readonly_source_block": {
        relationBlobs.add(requireSourceBlob(db, relation.sourceVersionId));
        if (inherited === undefined) assertSourceLocator(db, relation.sourceVersionId, relation.locator);
        if (relation.kind === "readonly_source_block" && relation.previewDerivativeId !== null) {
          const derivative = requireDerivative(db, relation.previewDerivativeId);
          if (inherited === undefined) {
            const occurrence = db.prepare("SELECT id FROM occurrences WHERE source_version_id = ? AND locator_json = ? AND asset_id = ?")
              .get(relation.sourceVersionId, JSON.stringify(relation.locator), derivative.asset_id);
            if (occurrence === undefined) throw unknownReference({ refType: "derivative", refId: relation.previewDerivativeId });
          }
          relationBlobs.add(derivative.blob_hash);
        }
        break;
      }
      case "fact": {
        const fact = input.fixedEvidence?.find(
          (item): item is Extract<FixedEvidence, { kind: "fact" }> =>
            item.kind === "fact" && item.entity.factVersionId === relation.factVersionId,
        );
        if (fact === undefined) {
          throw new RevisionCommitError(
            "UNKNOWN_REFERENCE",
            "事实引用缺少完整 FactEntity 固定证据",
            { factVersionId: relation.factVersionId },
          );
        }
        for (const sourceVersionId of fact.entity.sourceVersionIds) {
          addRef(transitive, "source_version", sourceVersionId);
          relationBlobs.add(requireSourceBlob(db, sourceVersionId));
        }
        break;
      }
      case "user_assertion": {
        const message = queryOne(db, MessageRowSchema,
          "SELECT m.id, m.role, c.content_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?", relation.messageId);
        if (message === null || message.role !== "user" || message.content_id !== input.contentId) throw unknownReference({ refType: "message", refId: relation.messageId });
        break;
      }
      default: {
        const exhaustive: never = relation;
        return exhaustive;
      }
    }
    for (const hash of relationBlobs) {
      if (inherited !== undefined && !inherited.blobHashes.includes(hash)) throw unresolvedHistory("历史引用的 blob 关系无法证明");
      if (db.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").get(hash) === undefined) throw unknownReference(refs[0] ?? { refType: "source_version", refId: input.contentId });
      blobs.add(hash);
    }
  }
  const ordered = {
    schemaVersion: 1 as const,
    directRefs: refs,
    transitiveRefs: dedupeRefs(transitive),
    blobHashes: [...blobs].sort(),
    bindings: [...bindings.values()].sort((left, right) => left.requestedOccurrenceId.localeCompare(right.requestedOccurrenceId)),
  };
  return RevisionEvidenceSchema.parse({ ...ordered, bindingHash: sha256(stableJson(ordered)) });
}

function unresolvedHistory(message: string): RevisionCommitError {
  return new RevisionCommitError("REFERENCE_HISTORY_UNRESOLVED", message);
}

function requireSourceBlob(db: Database.Database, id: string): string {
  const source = queryOne(db, SourceVersionBlobRowSchema, "SELECT id, snapshot_blob_hash FROM source_versions WHERE id = ?", id);
  if (source === null) throw unknownReference({ refType: "source_version", refId: id });
  return source.snapshot_blob_hash;
}

function requireAssetVersion(db: Database.Database, id: string): z.infer<typeof AssetRowSchema> {
  const asset = queryOne(db, AssetRowSchema,
    "SELECT a.id, a.blob_hash, a.media_kind FROM asset_versions av JOIN assets a ON a.id = av.asset_id WHERE av.id = ?", id);
  if (asset === null) throw unknownReference({ refType: "asset_version", refId: id });
  return asset;
}

function requireDerivative(db: Database.Database, id: string): z.infer<typeof DerivativeRowSchema> {
  const derivative = queryOne(db, DerivativeRowSchema, "SELECT id, asset_id, blob_hash FROM derivatives WHERE id = ?", id);
  if (derivative === null) throw unknownReference({ refType: "derivative", refId: id });
  return derivative;
}

function assertSourceLocator(db: Database.Database, sourceVersionId: string, locator: Locator): void {
  const rows = z.array(z.strictObject({ locator_json: z.string() })).parse([
    ...db.prepare("SELECT locator_json FROM occurrences WHERE source_version_id = ?").all(sourceVersionId),
    ...db.prepare("SELECT locator_json FROM document_sections WHERE source_version_id = ?").all(sourceVersionId),
    ...db.prepare("SELECT locator_json FROM document_blocks WHERE source_version_id = ?").all(sourceVersionId),
  ]);
  if (!rows.some(row => stableJson(LocatorSchema.parse(JSON.parse(row.locator_json) as unknown)) === stableJson(locator))) {
    throw unknownReference({ refType: "source_version", refId: sourceVersionId });
  }
}

function requireAssetChild(
  db: Database.Database,
  id: string,
  assetId: string,
  table: "derivative" | "segment",
): void {
  const row = table === "derivative"
    ? queryOne(db, DerivativeRowSchema, "SELECT id, asset_id, blob_hash FROM derivatives WHERE id = ?", id)
    : queryOne(db, SegmentRowSchema,
        "SELECT id, asset_id, start_ms, end_ms, derivative_id FROM segments WHERE id = ?", id);
  if (row === null || row.asset_id !== assetId) {
    throw new RevisionCommitError(
      "UNKNOWN_REFERENCE",
      `${table} 不属于素材版本对应的素材`,
    );
  }
}

function queryOne<T>(
  db: Database.Database,
  schema: z.ZodType<T>,
  sql: string,
  id: string,
): T | null {
  const row = db.prepare(sql).get(id);
  return row === undefined ? null : schema.parse(row);
}

function addRef(refs: RevisionRef[], refType: RevisionRefType, refId: string): void {
  if (!refs.some((ref) => ref.refType === refType && ref.refId === refId)) {
    refs.push({ refType, refId });
  }
}

function addBinding(bindings: Map<string, OccurrenceBinding>, occurrence: OccurrenceRow): void {
  if (bindings.has(occurrence.id)) return;
  const locator = LocatorSchema.parse(JSON.parse(occurrence.locator_json) as unknown);
  bindings.set(occurrence.id, {
    requestedOccurrenceId: occurrence.id,
    canonicalOccurrenceId: occurrence.canonical_id ?? occurrence.id,
    observedVersion: occurrence.version,
    sourceVersionId: occurrence.source_version_id,
    locator,
    assetIdAtCapture: occurrence.asset_id,
    relationHash: sha256(stableJson({
      requestedOccurrenceId: occurrence.id,
      canonicalOccurrenceId: occurrence.canonical_id ?? occurrence.id,
      observedVersion: occurrence.version,
      sourceVersionId: occurrence.source_version_id,
      locator,
      assetIdAtCapture: occurrence.asset_id,
    })),
  });
}

function dedupeRefs(refs: readonly RevisionRef[]): RevisionRef[] {
  const map = new Map<string, RevisionRef>();
  for (const ref of refs) map.set(`${ref.refType}:${ref.refId}`, RevisionRefSchema.parse(ref));
  return [...map.values()].sort((left, right) =>
    left.refType.localeCompare(right.refType) || left.refId.localeCompare(right.refId));
}

function unknownReference(ref: RevisionRef): RevisionCommitError {
  return new RevisionCommitError("UNKNOWN_REFERENCE", "修订引用了不存在或关系无效的实体", { ref });
}

function historicalEvidence(
  db: Database.Database,
  revisionId: string,
  ast: Ast,
  templateVersionId: string | null,
): RevisionEvidence {
  const row = db.prepare(
    `SELECT revision_id, schema_version, direct_refs_json, transitive_refs_json,
            blob_hashes_json, bindings_json, binding_hash, created_at
     FROM revision_evidence WHERE revision_id = ?`,
  ).get(revisionId);
  if (row !== undefined) {
    const parsed = EvidenceRowSchema.parse(row);
    const evidence = RevisionEvidenceSchema.parse({
      schemaVersion: parsed.schema_version,
      directRefs: JSON.parse(parsed.direct_refs_json) as unknown,
      transitiveRefs: JSON.parse(parsed.transitive_refs_json) as unknown,
      blobHashes: JSON.parse(parsed.blob_hashes_json) as unknown,
      bindings: JSON.parse(parsed.bindings_json) as unknown,
      bindingHash: parsed.binding_hash,
    });
    assertHistoricalEvidence(evidence, ast, templateVersionId);
    return evidence;
  }

  const refs = deriveRevisionRefs({ ast, templateVersionId });
  if (refs.length > 0) {
    throw new RevisionCommitError(
      "REFERENCE_HISTORY_UNRESOLVED",
      "历史修订缺少可证明的引用闭包，不能从当前关联推断",
    );
  }
  return RevisionEvidenceSchema.parse({
    schemaVersion: 1,
    directRefs: [],
    transitiveRefs: [],
    blobHashes: [],
    bindings: [],
    bindingHash: sha256(stableJson({
      schemaVersion: 1,
      directRefs: [],
      transitiveRefs: [],
      blobHashes: [],
      bindings: [],
    })),
  });
}

function assertHistoricalEvidence(
  evidence: RevisionEvidence,
  ast: Ast,
  templateVersionId: string | null,
): void {
  const expectedHash = sha256(stableJson({
    schemaVersion: evidence.schemaVersion,
    directRefs: evidence.directRefs,
    transitiveRefs: evidence.transitiveRefs,
    blobHashes: evidence.blobHashes,
    bindings: evidence.bindings,
  }));
  if (expectedHash !== evidence.bindingHash) {
    throw new RevisionCommitError(
      "REFERENCE_HISTORY_UNRESOLVED",
      "历史修订证据 hash 不一致",
    );
  }
  if (stableJson(dedupeRefs(evidence.directRefs)) !== stableJson(dedupeRefs(deriveRevisionRefs({ ast, templateVersionId })))) {
    throw unresolvedHistory("历史修订直接引用与 AST 不一致");
  }
  const directKeys = new Set(
    evidence.directRefs.map((ref) => `${ref.refType}:${ref.refId}`),
  );
  for (const ref of deriveRevisionRefs({ ast, templateVersionId })) {
    if (!directKeys.has(`${ref.refType}:${ref.refId}`)) {
      throw new RevisionCommitError(
        "REFERENCE_HISTORY_UNRESOLVED",
        "历史修订 AST 引用了未固定的证据",
      );
    }
  }
  const transitiveKeys = new Set(
    evidence.transitiveRefs.map((ref) => `${ref.refType}:${ref.refId}`),
  );
  const occurrenceIds = evidence.directRefs.filter(ref => ref.refType === "occurrence").map(ref => ref.refId).sort();
  if (stableJson(evidence.bindings.map(binding => binding.requestedOccurrenceId).sort()) !== stableJson(occurrenceIds)) {
    throw unresolvedHistory("历史 occurrence 绑定不完整");
  }
  for (const binding of evidence.bindings) {
    const { relationHash, ...relation } = binding;
    if (sha256(stableJson(relation)) !== relationHash || !transitiveKeys.has(`source_version:${binding.sourceVersionId}`)) {
      throw unresolvedHistory("历史 occurrence 关系 hash 或来源闭包不一致");
    }
  }
  for (const ref of evidence.directRefs) {
    if (!transitiveKeys.has(`${ref.refType}:${ref.refId}`)) {
      throw new RevisionCommitError(
        "REFERENCE_HISTORY_UNRESOLVED",
        "历史修订直接引用不在固定闭包内",
      );
    }
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseRevisionAst(input: unknown): Ast {
  return AstSchema.parse(input);
}
