import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AuthoringOperationSchema,
  CandidateViewSchema,
  ClaimSchema,
  CreateCandidateRequestSchema,
  MergePreviewSchema,
  type CandidateView,
  type CreateCandidateRequest,
  type MergePreview,
} from "@dmall/contracts";
import {
  applyEditOperations,
  assertValidAst,
  compareThreeWay,
  resolveDecisions,
} from "@dmall/domain";
import { canonicalHash } from "@dmall/templates";
import { ApiError } from "../errors.js";
import type { RevisionRepository } from "./revisions.js";
import { GenerationInputService } from "./generation-inputs.js";
import { evidenceEntityHash } from "./evidence-hash.js";
import { previewToken } from "./preview-token.js";
import { sha256, stableJson } from "./revision-commit.js";
import { templateAstValid } from "./template-check.js";

const CandidateRowSchema = z.strictObject({
  id: z.uuid(),
  rendition_id: z.uuid(),
  base_revision_id: z.uuid(),
  input_id: z.uuid(),
  confirmation_id: z.uuid(),
  template_version_id: z.uuid(),
  operations_json: z.string(),
  claims_json: z.string(),
  payload_hash: z.string(),
  status: z.enum(["pending", "accepted", "rejected", "conflicted"]),
  model_run_id: z.string().nullable(),
  applied_revision_id: z.uuid().nullable(),
  acceptance_hash: z.string().nullable(),
  accepted_decisions_json: z.string().nullable(),
  accepted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export class CandidateService {
  private readonly inputs: GenerationInputService;

  constructor(
    private readonly db: Database.Database,
    private readonly revisions: RevisionRepository,
    inputs?: GenerationInputService,
  ) {
    this.inputs = inputs ?? new GenerationInputService(db, undefined as never);
  }

  create(renditionId: string, request: CreateCandidateRequest): CandidateView {
    const inputRequest = CreateCandidateRequestSchema.parse(request);
    return this.db.transaction(() => {
      const generation = this.inputs.require(inputRequest.inputId);
      if (generation.renditionId !== renditionId) {
        throw new ApiError({ statusCode: 422, code: "TARGET_SCOPE_INVALID", message: "生成输入不属于目标分支" });
      }
      const base = this.revisions.viewById(generation.baseRevisionId);
      const allowed = new Set(generation.evidence.flatMap((item) => [
        item.kind === "fact" ? item.entity.factVersionId : "",
        item.kind === "source" ? item.sourceVersionId : "",
        item.kind === "media" ? item.assetVersionId : "",
        item.kind === "media" ? item.occurrence?.requestedOccurrenceId ?? "" : "",
        item.kind === "media" ? item.occurrence?.sourceVersionId ?? "" : "",
        item.kind === "media" ? item.derivative?.id ?? "" : "",
        item.kind === "media" ? item.segment?.id ?? "" : "",
        item.kind === "media" ? item.poster?.id ?? "" : "",
        item.kind === "user_assertion" ? item.messageId : "",
      ]).filter((id) => id !== ""));
      const applied = applyEditOperations({
        ast: base.ast,
        operations: [...inputRequest.operations],
        rules: {
          rootNodeId: generation.rootNodeId,
          actor: "ai",
          allowedReferenceIds: allowed,
        },
      });
      if (!applied.ok) {
        throw new ApiError({
          statusCode: 422,
          code: applied.violations.some((item) => item.code === "LOCKED_FIELD") ? "LOCKED_FIELD" : "AST_INVALID",
          message: applied.violations[0]?.message ?? "候选操作无效",
          details: { violations: applied.violations },
        });
      }
      assertValidAst(applied.ast);
      if (!templateAstValid(generation.templatePackage, applied.ast)) {
        throw new ApiError({
          statusCode: 422,
          code: "TEMPLATE_INVALID",
          message: "候选稿不符合固定模板的版式、类型或标题容量",
        });
      }
      const payloadHash = sha256(stableJson({
        operations: inputRequest.operations,
        claims: inputRequest.claims,
      }));
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO ai_candidates(
          id, rendition_id, base_revision_id, operations_json, status,
          model_run_id, created_at, updated_at, input_id, confirmation_id,
          template_version_id, target_node_ids_json, content_version_at_plan,
          plan_hash, payload_hash, claims_json
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        renditionId,
        generation.baseRevisionId,
        JSON.stringify(inputRequest.operations),
        inputRequest.modelRunId,
        now,
        now,
        generation.id,
        generation.confirmationId,
        generation.templateVersionId,
        JSON.stringify(generation.targetNodeIds),
        this.planContentVersion(generation.confirmationId),
        this.planHash(generation.confirmationId),
        payloadHash,
        JSON.stringify(inputRequest.claims),
      );
      return this.require(id);
    }).immediate();
  }

  require(candidateId: string): CandidateView {
    const row = this.db.prepare(
      `SELECT id, rendition_id, base_revision_id, input_id, confirmation_id,
              template_version_id, operations_json, claims_json, payload_hash,
              status, model_run_id, applied_revision_id, acceptance_hash,
              accepted_decisions_json, accepted_at, created_at, updated_at
       FROM ai_candidates WHERE id = ?`,
    ).get(candidateId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "候选稿不存在" });
    }
    return toView(CandidateRowSchema.parse(row));
  }

  preview(candidateId: string): MergePreview {
    const candidate = this.require(candidateId);
    const input = this.inputs.require(candidate.inputId);
    const base = this.revisions.viewById(candidate.baseRevisionId);
    const rendition = z.strictObject({
      current_revision_id: z.uuid(),
    }).parse(this.db.prepare("SELECT current_revision_id FROM renditions WHERE id = ?").get(candidate.renditionId));
    const current = this.revisions.viewById(rendition.current_revision_id);
    const candidateResult = applyEditOperations({
      ast: base.ast,
      operations: candidate.operations,
      rules: { rootNodeId: input.rootNodeId, actor: "ai", allowedReferenceIds: new Set(input.evidence.flatMap(evidenceReferenceIds)) },
    });
    const comparison = compareThreeWay({
      rootNodeId: input.rootNodeId,
      base,
      current,
      candidate: {
        id: candidate.id,
        baseRevisionId: candidate.baseRevisionId,
        operations: candidate.operations,
      },
      targetNodeIds: input.targetNodeIds,
      templateValid: templateAstValid(input.templatePackage, current.ast, candidateResult.ok ? candidateResult.ast : base.ast),
      allowedReferenceIds: new Set(input.evidence.flatMap(evidenceReferenceIds)),
    });
    const allKeepDecisions = comparison.conflictGroupIds.map((groupId) => ({
      groupId,
      choice: "keep_current" as const,
    }));
    let resolvedAst = null;
    try {
      resolvedAst = resolveDecisions({
        rootNodeId: input.rootNodeId,
        base,
        current,
        candidate: { id: candidate.id, baseRevisionId: candidate.baseRevisionId, operations: candidate.operations },
        targetNodeIds: input.targetNodeIds,
        comparison,
        decisions: allKeepDecisions,
        allowedReferenceIds: new Set(input.evidence.flatMap(evidenceReferenceIds)),
      }).ast;
    } catch {
      resolvedAst = null;
    }
    const templateRulesHash = canonicalHash(input.templatePackage);
    const evidenceRelationHash = sha256(stableJson(input.evidence.map(evidenceEntityHash).sort()));
    const evidenceAvailabilityHash = sha256(stableJson(current.references.map((item) => ({
      ref: item.ref,
      state: item.state.kind,
    }))));
    const binding = {
      schemaVersion: 1 as const,
      algorithmVersion: "t06-merge/1" as const,
      candidateId: candidate.id,
      payloadHash: candidate.payloadHash,
      baseRevisionId: candidate.baseRevisionId,
      currentRevisionId: current.id,
      templateVersionId: input.templateVersionId,
      templateRulesHash,
      evidenceRelationHash,
      evidenceAvailabilityHash,
      groupIds: comparison.groups.map((group) => group.groupId).sort(),
      automaticOperationIndexes: comparison.automaticGroupIds
        .flatMap((groupId) => comparison.groups.find((group) => group.groupId === groupId)?.operationIndexes ?? [])
        .sort((a, b) => a - b),
      conflictGroupIds: comparison.conflictGroupIds,
      blockedGroupIds: comparison.blockedGroupIds,
    };
    return MergePreviewSchema.parse({
      candidateId: candidate.id,
      baseRevisionId: base.id,
      currentRevisionId: current.id,
      baseAst: base.ast,
      currentAst: current.ast,
      candidateAst: comparison.candidateAst!,
      resolvedAst,
      groups: comparison.groups.map((group) => ({
        groupId: group.groupId,
        classification: group.classification,
        kind: group.kind,
        nodeIds: group.nodeIds,
        anchors: group.anchors,
        semanticTags: group.semanticTags,
        operationIndexes: group.operationIndexes,
        baseValue: group.baseValue,
        currentValue: group.currentValue,
        candidateValue: group.candidateValue,
        reason: group.reason,
      })),
      automaticGroupIds: comparison.automaticGroupIds,
      satisfiedGroupIds: comparison.satisfiedGroupIds,
      conflictGroupIds: comparison.conflictGroupIds,
      blockedGroupIds: comparison.blockedGroupIds,
      previewToken: previewToken(binding),
      previewBinding: binding,
    });
  }

  reject(candidateId: string, input: { expectedRevisionId: string; reason: string }): CandidateView {
    return this.db.transaction(() => {
      const candidate = this.require(candidateId);
      if (candidate.status === "accepted") {
        throw new ApiError({ statusCode: 409, code: "CANDIDATE_TERMINAL", message: "候选稿已接受，不能拒绝" });
      }
      if (candidate.status === "rejected") return candidate;
      const current = z.strictObject({ current_revision_id: z.uuid() }).parse(
        this.db.prepare("SELECT current_revision_id FROM renditions WHERE id = ?").get(candidate.renditionId),
      );
      if (current.current_revision_id !== input.expectedRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "稿件已变化，拒绝候选前请刷新",
          details: { currentRevisionId: current.current_revision_id },
        });
      }
      const updated = this.db.prepare(
        `UPDATE ai_candidates SET status = 'rejected', rejected_reason = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'conflicted')`,
      ).run(input.reason, new Date().toISOString(), candidateId);
      if (updated.changes !== 1) {
        throw new ApiError({ statusCode: 409, code: "CANDIDATE_TERMINAL", message: "候选稿已终结" });
      }
      return this.require(candidateId);
    }).immediate();
  }

  private planContentVersion(confirmationId: string): number {
    return z.strictObject({ content_version: z.number().int() }).parse(
      this.db.prepare("SELECT content_version FROM authoring_confirmations WHERE id = ?").get(confirmationId),
    ).content_version;
  }

  private planHash(confirmationId: string): string {
    return z.strictObject({ plan_hash: z.string() }).parse(
      this.db.prepare("SELECT plan_hash FROM authoring_confirmations WHERE id = ?").get(confirmationId),
    ).plan_hash;
  }
}

function toView(row: z.infer<typeof CandidateRowSchema>): CandidateView {
  return CandidateViewSchema.parse({
    id: row.id,
    renditionId: row.rendition_id,
    baseRevisionId: row.base_revision_id,
    inputId: row.input_id,
    confirmationId: row.confirmation_id,
    templateVersionId: row.template_version_id,
    operations: z.array(AuthoringOperationSchema).parse(JSON.parse(row.operations_json) as unknown),
    claims: z.array(ClaimSchema).parse(JSON.parse(row.claims_json) as unknown),
    payloadHash: row.payload_hash,
    status: row.status,
    modelRunId: row.model_run_id,
    appliedRevisionId: row.applied_revision_id,
    acceptanceHash: row.acceptance_hash,
    acceptedDecisions: row.accepted_decisions_json === null ? null : JSON.parse(row.accepted_decisions_json) as unknown[],
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function evidenceReferenceIds(
  evidence: import("@dmall/contracts").FixedEvidence,
): string[] {
  if (evidence.kind === "source") return [evidence.sourceVersionId];
  if (evidence.kind === "fact") return [evidence.entity.factVersionId, ...evidence.entity.sourceVersionIds];
  if (evidence.kind === "media") {
    return [
      evidence.assetVersionId,
      evidence.occurrence?.requestedOccurrenceId ?? "",
      evidence.occurrence?.sourceVersionId ?? "",
      evidence.derivative?.id ?? "",
      evidence.segment?.id ?? "",
      evidence.poster?.id ?? "",
    ].filter((id) => id !== "");
  }
  return [evidence.messageId];
}
