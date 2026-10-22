import type {
  Ast,
  AuthoringOperation,
  CandidateDecision,
  RevisionView,
} from "@dmall/contracts";
import { assertValidAst, DomainValidationError } from "../ast.js";
import { applyEditOperations } from "../operations.js";
import {
  buildMergeGroups,
  canonicalJson,
  expandedInsertScope,
  type MergeGroup,
} from "./groups.js";

export interface MergeInput {
  readonly rootNodeId: string;
  readonly base: RevisionView;
  readonly current: RevisionView;
  readonly candidate: {
    readonly id: string;
    readonly baseRevisionId: string;
    readonly operations: readonly AuthoringOperation[];
  };
  readonly targetNodeIds: readonly string[];
  readonly templateValid?: boolean;
  readonly allowedReferenceIds?: ReadonlySet<string>;
}

export interface MergeComparison {
  groups: MergeGroup[];
  candidateAst: Ast | null;
  automaticGroupIds: string[];
  satisfiedGroupIds: string[];
  conflictGroupIds: string[];
  blockedGroupIds: string[];
}

export function compareThreeWay(input: MergeInput): MergeComparison {
  if (input.base.id !== input.current.id && input.current.renditionId !== input.base.renditionId) {
    throw new Error("base 与 current 不属于同一稿件分支");
  }
  if (input.candidate.baseRevisionId !== input.base.id) {
    throw new Error("candidate 的基线不是给定 base");
  }
  const result = buildMergeGroups({
    rootNodeId: input.rootNodeId,
    base: input.base,
    current: input.current,
    candidate: input.candidate,
    targetNodeIds: input.targetNodeIds,
    templateValid: input.templateValid ?? true,
  });
  return {
    groups: result.groups,
    candidateAst: result.candidateAst,
    automaticGroupIds: result.groups.filter((group) => group.classification === "automatic").map((group) => group.groupId),
    satisfiedGroupIds: result.groups.filter((group) => group.classification === "satisfied").map((group) => group.groupId),
    conflictGroupIds: result.groups.filter((group) => group.classification === "conflict").map((group) => group.groupId),
    blockedGroupIds: result.groups.filter((group) => group.classification === "blocked").map((group) => group.groupId),
  };
}

export class MergeResolutionError extends Error {
  readonly code: "DECISIONS_INVALID" | "AST_INVALID" | "TARGET_SCOPE_INVALID" | "LOCKED_FIELD";
  readonly details: Record<string, unknown>;

  constructor(
    code: MergeResolutionError["code"],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MergeResolutionError";
    this.code = code;
    this.details = details;
  }
}

export function resolveDecisions(input: MergeInput & {
  readonly comparison: MergeComparison;
  readonly decisions: readonly CandidateDecision[];
}): { ast: Ast; appliedGroupIds: string[]; keptGroupIds: string[] } {
  validateDecisions(input.comparison, input.decisions);
  const byId = new Map(input.comparison.groups.map((group) => [group.groupId, group]));
  const decisionMap = new Map(input.decisions.map((decision) => [decision.groupId, decision.choice]));
  const selected: MergeGroup[] = [];
  for (const groupId of [...input.comparison.automaticGroupIds, ...input.comparison.conflictGroupIds]) {
    const group = byId.get(groupId);
    if (group === undefined) continue;
    if (group.classification === "conflict" && decisionMap.get(groupId) !== "accept_candidate") continue;
    selected.push(group);
  }
  selected.sort((left, right) => Math.min(...left.operationIndexes) - Math.min(...right.operationIndexes));

  let ast = structuredClone(input.current.ast);
  const appliedGroupIds: string[] = [];
  for (const group of selected) {
    const result = applyEditOperations({
      ast,
      operations: [...group.operations],
      rules: {
        rootNodeId: input.rootNodeId,
        actor: "ai",
        allowedReferenceIds: input.allowedReferenceIds ?? referenceIdsFromOperations(input.candidate.operations),
      },
    });
    if (!result.ok) {
      const locked = result.violations.some((item) => item.code === "LOCKED_FIELD");
      throw new MergeResolutionError(
        locked ? "LOCKED_FIELD" : "AST_INVALID",
        result.violations[0]?.message ?? "候选组无法应用到当前稿件",
        { groupId: group.groupId, violations: result.violations },
      );
    }
    ast = result.ast;
    appliedGroupIds.push(group.groupId);
  }

  try {
    ast = assertValidAst(ast);
  } catch (error) {
    throw new MergeResolutionError(
      "AST_INVALID",
      error instanceof DomainValidationError ? error.message : "合并后的 AST 无效",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  assertTargetScope(expandedInsertScope(input.targetNodeIds, input.candidate.operations), selected);
  const keptGroupIds = input.comparison.groups
    .filter((group) => group.classification === "blocked" || (group.classification === "conflict" && decisionMap.get(group.groupId) !== "accept_candidate"))
    .map((group) => group.groupId);
  return { ast, appliedGroupIds, keptGroupIds };
}

export function validateDecisions(comparison: MergeComparison, decisions: readonly CandidateDecision[]): void {
  const conflict = new Set(comparison.conflictGroupIds);
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.groupId)) {
      throw new MergeResolutionError("DECISIONS_INVALID", "决策组重复", { groupId: decision.groupId });
    }
    seen.add(decision.groupId);
    if (!conflict.has(decision.groupId)) {
      throw new MergeResolutionError("DECISIONS_INVALID", "只能为冲突组提交决策", { groupId: decision.groupId });
    }
  }
  for (const groupId of conflict) {
    if (!seen.has(groupId)) {
      throw new MergeResolutionError("DECISIONS_INVALID", "冲突组缺少决策", { groupId });
    }
  }
}

export function acceptanceMaterial(input: MergeInput & {
  readonly comparison: MergeComparison;
  readonly decisions: readonly CandidateDecision[];
}): {
  groupIds: string[];
  automaticOperationIndexes: number[];
  conflictGroupIds: string[];
  blockedGroupIds: string[];
  evidenceClosureHash: string;
} {
  const selected = input.comparison.groups.filter((group) =>
    group.classification === "automatic" ||
    (group.classification === "conflict" &&
      input.decisions.some((decision) => decision.groupId === group.groupId && decision.choice === "accept_candidate")),
  );
  return {
    groupIds: input.comparison.groups.map((group) => group.groupId),
    automaticOperationIndexes: selected.flatMap((group) => group.operationIndexes).sort((a, b) => a - b),
    conflictGroupIds: input.comparison.conflictGroupIds,
    blockedGroupIds: input.comparison.blockedGroupIds,
    evidenceClosureHash: evidenceClosureHash(input.current, input.allowedReferenceIds),
  };
}

export function evidenceClosureHash(view: RevisionView, allowed?: ReadonlySet<string>): string {
  return createHashValue({
    evidenceHash: view.evidenceHash,
    references: view.references,
    allowed: allowed === undefined ? null : [...allowed].sort(),
  });
}

export function createHashValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function referenceIdsFromOperations(operations: readonly AuthoringOperation[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (operation.op === "setField") {
      if (["assetVersionId", "occurrenceId", "posterDerivativeId"].includes(operation.path) && typeof operation.value === "string") ids.add(operation.value);
      if (["derivativeId", "segmentId"].includes(operation.path) && typeof operation.value === "string") ids.add(operation.value);
      if (operation.path === "provenance") {
        for (const item of operation.value) {
          if (item.kind === "source") ids.add(item.sourceVersionId);
          if (item.kind === "fact") ids.add(item.factVersionId);
          if (item.kind === "user_assertion") ids.add(item.messageId);
        }
      }
    }
    if (operation.op === "insertNode") {
      const blocks = "type" in operation.node ? [operation.node] : operation.node.blocks;
      for (const block of blocks) {
        if (block.type === "image") {
          ids.add(block.assetVersionId);
          ids.add(block.occurrenceId);
          if (block.derivativeId !== null) ids.add(block.derivativeId);
        }
        if (block.type === "video") {
          ids.add(block.assetVersionId);
          ids.add(block.posterDerivativeId);
          if (block.segmentId !== null) ids.add(block.segmentId);
        }
        if (block.type === "readonly_source_block") ids.add(block.sourceVersionId);
        for (const item of block.provenance) {
          if (item.kind === "source") ids.add(item.sourceVersionId);
          if (item.kind === "fact") ids.add(item.factVersionId);
          if (item.kind === "user_assertion") ids.add(item.messageId);
        }
      }
    }
  }
  return ids;
}

function assertTargetScope(targetNodeIds: readonly string[], groups: readonly MergeGroup[]): void {
  if (targetNodeIds.length === 0) return;
  const scope = new Set(targetNodeIds);
  for (const group of groups) {
    for (const key of group.writeSet) {
      const [type, id] = key.split(":");
      if (id === undefined || type === "children") continue;
      if (!scope.has(id)) {
        throw new MergeResolutionError(
          "TARGET_SCOPE_INVALID",
          "候选改写了目标范围外的节点",
          { groupId: group.groupId, nodeId: id },
        );
      }
    }
  }
}

import { createHash } from "node:crypto";
