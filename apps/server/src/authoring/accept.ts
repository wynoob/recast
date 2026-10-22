import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AcceptCandidateResultSchema,
  AcceptanceBindingSchema,
  AcceptCandidateRequestSchema,
  CandidateDecisionSchema,
  type AcceptCandidateRequest,
  type AcceptCandidateResult,
  type AcceptanceBinding,
  type ConfirmedComposition,
} from "@dmall/contracts";
import {
  compareThreeWay,
  resolveDecisions,
  validateDecisions,
} from "@dmall/domain";
import { ApiError } from "../errors.js";
import type { IdempotencyRepository } from "../idempotency.js";
import { CandidateService } from "./candidates.js";
import { GenerationInputService } from "./generation-inputs.js";
import { PlanService } from "./plans.js";
import {
  acceptanceBinding,
  acceptanceHash,
  sortedDecisions,
} from "./preview-token.js";
import { commitRevision, stableJson } from "./revision-commit.js";
import { templateAstValid } from "./template-check.js";
import type { RevisionRepository } from "./revisions.js";

export interface AcceptContext {
  routeScope: string;
  key: string;
  requestHash: string;
  requestId: string;
  automaticComposition?: string;
}

export class CandidateAcceptService {
  private readonly plans: PlanService;
  private readonly inputs: GenerationInputService;

  constructor(
    private readonly db: Database.Database,
    private readonly revisions: RevisionRepository,
    private readonly candidates: CandidateService,
    private readonly idempotency: IdempotencyRepository,
    inputs?: GenerationInputService,
    plans?: PlanService,
  ) {
    this.inputs = inputs ?? new GenerationInputService(db, undefined as never);
    this.plans = plans ?? new PlanService(db);
  }

  acceptComposition(fixed: ConfirmedComposition, candidateId: string): AcceptCandidateResult {
    return this.db.transaction(() => {
      const candidate = this.candidates.require(candidateId);
      const input = this.inputs.require(candidate.inputId);
      const stored = this.plans.composition(fixed.proposal.contentId);
      if (stored?.snapshotHash !== fixed.snapshotHash || input.confirmationId !== fixed.confirmationId ||
          input.compositionSnapshotHash !== fixed.snapshotHash || candidate.baseRevisionId !== fixed.emptyBaseRevisionId || candidate.renditionId !== fixed.renditionId) {
        throw new ApiError({ statusCode: 409, code: "COMPOSITION_CONFLICT", message: "候选不属于确认的独占空稿" });
      }
      if (candidate.status === "accepted" && candidate.appliedRevisionId !== null && candidate.acceptanceHash !== null) {
        return AcceptCandidateResultSchema.parse({ candidate, revision: this.revisions.viewById(candidate.appliedRevisionId), acceptanceHash: candidate.acceptanceHash, replayed: true });
      }
      const base = this.revisions.viewById(fixed.emptyBaseRevisionId);
      const empty = base.ast.kind === "feishu_doc" ? base.ast.sections.length === 0 : base.ast.slides.length === 0;
      if (!empty || this.currentRevision(fixed.renditionId) !== fixed.emptyBaseRevisionId) {
        throw new ApiError({ statusCode: 409, code: "REVISION_CONFLICT", message: "空稿基线已变化，不能自动覆盖" });
      }
      const preview = this.candidates.preview(candidateId);
      if (preview.conflictGroupIds.length > 0 || preview.blockedGroupIds.length > 0) {
        throw new ApiError({ statusCode: 422, code: "DRAFT_INVALID", message: "全文候选存在冲突或阻断，不能自动接收" });
      }
      const request = AcceptCandidateRequestSchema.parse({ schemaVersion: 1, expectedRevisionId: fixed.emptyBaseRevisionId, previewToken: preview.previewToken, decisions: [], frozenPlanAcknowledgement: null });
      return this.accept(candidateId, request, { routeScope: "composition:auto-accept", key: fixed.confirmationId,
        requestHash: fixed.snapshotHash, requestId: fixed.confirmationId, automaticComposition: fixed.proposal.id }).result;
    }).immediate();
  }

  accept(
    candidateId: string,
    body: AcceptCandidateRequest,
    context: AcceptContext,
  ): { statusCode: number; response: unknown; result: AcceptCandidateResult } {
    const request = AcceptCandidateRequestSchema.parse(body);
    return this.db.transaction(() => {
      const replay = this.replay(context);
      if (replay !== null) {
        const parsed = z.strictObject({
          data: AcceptCandidateResultSchema,
          requestId: z.string(),
        }).parse(replay.response);
        return { statusCode: replay.statusCode, response: replay.response, result: parsed.data };
      }
      const candidate = this.candidates.require(candidateId);
      const input = this.inputs.require(candidate.inputId);
      if (candidate.status === "accepted") {
        const stored = this.storedBinding(candidate.id);
        const requested = this.bindingFromStored(stored, request);
        const requestedHash = acceptanceHash(requested);
        if (requestedHash !== candidate.acceptanceHash || candidate.appliedRevisionId === null) {
          throw new ApiError({
            statusCode: 409,
            code: "CANDIDATE_ALREADY_ACCEPTED",
            message: "候选稿已用不同决策接受，不能再次变更",
          });
        }
        const result = AcceptCandidateResultSchema.parse({
          candidate,
          revision: this.revisions.viewById(candidate.appliedRevisionId),
          acceptanceHash: requestedHash,
          replayed: true,
        });
        const response = { data: result, requestId: context.requestId };
        this.saveReceipt(context, response, candidate.appliedRevisionId, 200);
        return { statusCode: 200, response, result };
      }
      if (candidate.status === "rejected") {
        throw new ApiError({ statusCode: 409, code: "CANDIDATE_TERMINAL", message: "候选稿已拒绝" });
      }
      const currentId = this.currentRevision(candidate.renditionId);
      if (currentId !== request.expectedRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "稿件已变化，候选预览已过期",
          details: { currentRevisionId: currentId },
        });
      }
      const preview = this.candidates.preview(candidate.id);
      if (preview.previewToken !== request.previewToken) {
        throw new ApiError({
          statusCode: 409,
          code: "PREVIEW_STALE",
          message: "预览对应的事实、模板或当前稿已变化，请重新预览",
          details: { currentPreviewToken: preview.previewToken },
        });
      }
      const decisions = sortedDecisions(z.array(CandidateDecisionSchema).parse(request.decisions));
      const confirmation = this.plans.getConfirmation(input.confirmationId);
      this.plans.requireCurrentAck({
        contentId: input.contentId,
        confirmation,
        acknowledgement: request.frozenPlanAcknowledgement,
      });
      const base = this.revisions.viewById(candidate.baseRevisionId);
      const current = this.revisions.viewById(preview.currentRevisionId);
      const allowedReferenceIds = new Set(input.evidence.flatMap((item) => {
        if (item.kind === "fact") return [item.entity.factVersionId, ...item.entity.sourceVersionIds];
        if (item.kind === "source") return [item.sourceVersionId];
        if (item.kind === "media") {
          return [
            item.assetVersionId,
            item.occurrence?.requestedOccurrenceId ?? "",
            item.occurrence?.sourceVersionId ?? "",
            item.derivative?.id ?? "",
            item.segment?.id ?? "",
            item.poster?.id ?? "",
          ].filter((id) => id !== "");
        }
        return [item.messageId];
      }));
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
        templateValid: templateAstValid(input.templatePackage, current.ast, preview.candidateAst),
        allowedReferenceIds,
      });
      validateDecisions(comparison, decisions);
      const resolved = resolveDecisions({
        rootNodeId: input.rootNodeId,
        base,
        current,
        candidate: {
          id: candidate.id,
          baseRevisionId: candidate.baseRevisionId,
          operations: candidate.operations,
        },
        targetNodeIds: input.targetNodeIds,
        comparison,
        decisions,
        allowedReferenceIds,
      });
      const binding = acceptanceBinding({
        candidateId: candidate.id,
        payloadHash: candidate.payloadHash,
        baseRevisionId: candidate.baseRevisionId,
        previewCurrentRevisionId: preview.currentRevisionId,
        previewToken: preview.previewToken,
        decisions,
        frozenPlanAcknowledgement: request.frozenPlanAcknowledgement,
        templateVersionId: input.templateVersionId,
        templateRulesHash: preview.previewBinding.templateRulesHash,
        evidenceClosureHash: createHash("sha256")
          .update(stableJson({
            relation: preview.previewBinding.evidenceRelationHash,
            availability: preview.previewBinding.evidenceAvailabilityHash,
          }), "utf8")
          .digest("hex"),
      });
      const hash = acceptanceHash(binding);
      const committed = commitRevision(this.db, {
        mode: "candidate_accept",
        renditionId: candidate.renditionId,
        candidateId: candidate.id,
        ast: resolved.ast,
        claims: candidate.claims,
        fixedEvidence: input.evidence,
        createdBy: "ai_accepted",
        expectedCurrentRevisionId: request.expectedRevisionId,
        reason: context.automaticComposition === undefined ? `接受候选稿 ${candidate.id}` : `按确认方案 ${context.automaticComposition} 自动接收全文`,
      });
      const now = new Date().toISOString();
      const updated = this.db.prepare(
        `UPDATE ai_candidates
         SET status = 'accepted', applied_revision_id = ?, acceptance_hash = ?,
             accepted_decisions_json = ?, acceptance_binding_json = ?, accepted_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'conflicted')`,
      ).run(
        committed.revisionId,
        hash,
        JSON.stringify(decisions),
        JSON.stringify(binding),
        now,
        now,
        candidate.id,
      );
      if (updated.changes !== 1) {
        throw new ApiError({ statusCode: 409, code: "CANDIDATE_TERMINAL", message: "候选稿已被其他请求终结" });
      }
      const result = AcceptCandidateResultSchema.parse({
        candidate: this.candidates.require(candidate.id),
        revision: this.revisions.viewById(committed.revisionId),
        acceptanceHash: hash,
        replayed: false,
      });
      const response = { data: result, requestId: context.requestId };
      this.saveReceipt(context, response, committed.revisionId, 201);
      return { statusCode: 201, response, result };
    }).immediate();
  }

  private bindingFromStored(stored: AcceptanceBinding, request: AcceptCandidateRequest): AcceptanceBinding {
    return {
      ...stored,
      previewToken: request.previewToken,
      decisions: sortedDecisions(request.decisions),
      frozenPlanAcknowledgement: request.frozenPlanAcknowledgement,
    };
  }

  private storedBinding(candidateId: string): AcceptanceBinding {
    const row = z.strictObject({
      acceptance_binding_json: z.string().nullable(),
    }).parse(this.db.prepare(
      "SELECT acceptance_binding_json FROM ai_candidates WHERE id = ?",
    ).get(candidateId));
    if (row.acceptance_binding_json === null) {
      throw new ApiError({
        statusCode: 409,
        code: "CANDIDATE_ALREADY_ACCEPTED",
        message: "候选已接受但缺少完整接受绑定",
      });
    }
    return AcceptanceBindingSchema.parse(JSON.parse(row.acceptance_binding_json) as unknown);
  }

  private currentRevision(renditionId: string): string {
    return z.strictObject({ current_revision_id: z.uuid() }).parse(
      this.db.prepare("SELECT current_revision_id FROM renditions WHERE id = ?").get(renditionId),
    ).current_revision_id;
  }

  private replay(context: AcceptContext): {
    statusCode: number;
    response: unknown;
  } | null {
    const existing = this.idempotency.find(context.routeScope, context.key);
    if (existing === null) return null;
    if (existing.requestHash !== context.requestHash) {
      throw new ApiError({
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "同一 Idempotency-Key 对应了不同请求",
      });
    }
    return { statusCode: existing.statusCode, response: existing.response };
  }

  private saveReceipt(context: AcceptContext, response: unknown, resultRef: string, statusCode: number): void {
    this.idempotency.save({
      routeScope: context.routeScope,
      key: context.key,
      requestHash: context.requestHash,
      statusCode,
      requestId: context.requestId,
      response,
      resultRef,
    });
  }
}
