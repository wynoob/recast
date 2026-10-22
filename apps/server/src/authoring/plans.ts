import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  BriefInputSchema,
  ProposalSchema,
  ConfirmedCompositionSchema,
  type Proposal,
  type ConfirmedComposition,
  type FixedEvidence,
  type TemplatePackage,
  ConfirmationViewSchema,
  NodeIdSchema,
  PlanViewSchema,
  QuestionDecisionSchema,
  type ConfirmPlanRequest,
  type ConfirmationView,
  type PlanView,
} from "@dmall/contracts";
import { createBrief } from "@dmall/domain";
import { ApiError } from "../errors.js";
import { MessageService } from "./messages.js";
import { sha256, stableJson } from "./revision-commit.js";

const ContentRowSchema = z.strictObject({
  id: z.uuid(),
  brief_json: z.string(),
  version: z.int().nonnegative(),
  kind: z.enum(["feishu_doc", "html_deck"]),
});

const ConfirmationRowSchema = z.strictObject({
  id: z.uuid(),
  content_id: z.uuid(),
  content_version: z.int().nonnegative(),
  brief_json: z.string(),
  outline_json: z.string(),
  question_decisions_json: z.string(),
  confirmed_by_message_id: z.uuid(),
  plan_hash: z.string(),
  created_at: z.string(),
});

export class PlanService {
  private readonly messages: MessageService;

  constructor(
    private readonly db: Database.Database,
    messages?: MessageService,
  ) {
    this.messages = messages ?? new MessageService(db);
  }

  proposal(id: string): Proposal {
    const row = this.db.prepare("SELECT proposal_json FROM authoring_proposals WHERE id = ?").get(id);
    if (row === undefined) throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "创作方案不存在" });
    return ProposalSchema.parse(JSON.parse(z.object({ proposal_json: z.string() }).parse(row).proposal_json));
  }

  currentProposal(contentId: string, version: number): Proposal | null {
    const row = this.db.prepare("SELECT id FROM authoring_proposals WHERE content_id = ? AND based_on_version = ?").get(contentId, version);
    return row === undefined ? null : this.proposal(z.object({ id: z.uuid() }).parse(row).id);
  }

  saveProposal(proposal: Proposal, recommendJobId: string): void {
    const value = ProposalSchema.parse(proposal);
    this.db.prepare(`INSERT INTO authoring_proposals(id, content_id, based_on_version, proposal_json, proposal_hash, recommend_job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.contentId, value.basedOnVersion, JSON.stringify(value), value.hash, recommendJobId, new Date().toISOString());
  }

  composition(contentId: string): ConfirmedComposition | null {
    const row = this.db.prepare("SELECT composition_snapshot_json FROM authoring_confirmations WHERE content_id = ? AND proposal_id IS NOT NULL").get(contentId);
    return row === undefined ? null : ConfirmedCompositionSchema.parse(JSON.parse(z.object({ composition_snapshot_json: z.string() }).parse(row).composition_snapshot_json));
  }

  confirmComposition(input: {
    proposal: Proposal; templatePackage: TemplatePackage; fixedEvidence: FixedEvidence[];
    renditionId: string; emptyBaseRevisionId: string; merchantId: string | null;
  }): ConfirmedComposition {
    return this.db.transaction(() => {
      const prior = this.composition(input.proposal.contentId);
      if (prior !== null) {
        if (prior.proposal.id !== input.proposal.id || prior.proposal.hash !== input.proposal.hash) {
          throw new ApiError({ statusCode: 409, code: "COMPOSITION_CONFIRMED", message: "该创作已确认其他方案" });
        }
        return prior;
      }
      const proposal = input.proposal;
      const content = this.requireContent(proposal.contentId);
      if (content.version !== proposal.basedOnVersion) throw new ApiError({ statusCode: 409, code: "PROPOSAL_STALE", message: "方案已被调整，请确认当前方案" });
      const message = this.messages.create(proposal.contentId, { schemaVersion: 1, mode: "note", text: "确认方案，授权生成全文、自动接收并交付所选成品", renditionId: input.renditionId, targetNodeIds: [] });
      const now = new Date().toISOString();
      const snapshot = {
        confirmationId: randomUUID(), proposal, confirmedContentVersion: content.version + 1,
        renditionId: input.renditionId, emptyBaseRevisionId: input.emptyBaseRevisionId,
        templatePackage: input.templatePackage, fixedEvidence: input.fixedEvidence,
        authorization: { kind: "generate_accept_deliver", messageId: message.id, confirmedAt: now },
      };
      const fixed = ConfirmedCompositionSchema.parse({ ...snapshot, snapshotHash: sha256(stableJson(snapshot)) });
      const outline = ("sections" in proposal ? proposal.sections.map((item) => item.heading) : proposal.slides.map((item) => item.title)).map((title) => ({ id: NodeIdSchema.parse(randomUUID()), title }));
      const brief = createBrief({ goal: proposal.purpose, audience: [proposal.audience], merchantId: input.merchantId, durationMinutes: null,
        userOutline: outline, mustKeepOutline: true, tone: "", sourceScope: { sourceVersionIds: [], excludeIds: [] }, unresolvedQuestions: [] }, { contentId: proposal.contentId, kind: proposal.delivery.kind });
      const changed = this.db.prepare("UPDATE contents SET version = version + 1, title = ?, brief_json = ?, merchant_id = ?, updated_at = ? WHERE id = ? AND version = ?")
        .run(proposal.title, JSON.stringify(brief), input.merchantId, now, proposal.contentId, proposal.basedOnVersion);
      if (changed.changes !== 1) throw new ApiError({ statusCode: 409, code: "COMPOSITION_CONFLICT", message: "创作版本已变化" });
      this.db.prepare(`INSERT INTO authoring_confirmations(id, content_id, content_version, brief_json, outline_json, question_decisions_json, confirmed_by_message_id, plan_hash, created_at, proposal_id, composition_snapshot_json, composition_snapshot_hash) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`)
        .run(fixed.confirmationId, proposal.contentId, fixed.confirmedContentVersion, JSON.stringify(brief), JSON.stringify(outline), message.id, proposal.hash, now, proposal.id, JSON.stringify(fixed), fixed.snapshotHash);
      this.db.prepare("UPDATE messages SET mode = 'confirm_outline', plan_id = ? WHERE id = ?").run(fixed.confirmationId, message.id);
      return fixed;
    }).immediate();
  }

  confirm(contentId: string, request: ConfirmPlanRequest): PlanView {
    const input = z.strictObject({
      schemaVersion: z.literal(1),
      expectedVersion: z.int().nonnegative(),
      brief: BriefInputSchema,
      outline: z.array(z.strictObject({ id: NodeIdSchema, title: z.string().min(1) })).min(1),
      questionDecisions: z.array(QuestionDecisionSchema),
      confirmationText: z.string().min(1),
      renditionId: z.uuid().nullable(),
    }).parse(request);

    return this.db.transaction(() => {
      const content = this.requireContent(contentId);
      if (content.version !== input.expectedVersion) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "内容需求已变化，请刷新后重新确认",
          details: { currentVersion: content.version },
        });
      }
      if (input.renditionId !== null) {
        const rendition = this.db.prepare(
          "SELECT id FROM renditions WHERE id = ? AND content_id = ?",
        ).get(input.renditionId, contentId);
        if (rendition === undefined) {
          throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "稿件分支不存在" });
        }
      }
      this.validateQuestions(contentId, input.brief.unresolvedQuestions, input.questionDecisions);
      const brief = createBrief(
        { ...input.brief, userOutline: input.outline },
        { contentId, kind: content.kind },
      );
      const confirmationMessage = this.messages.create(contentId, {
        schemaVersion: 1,
        mode: "note",
        text: input.confirmationText,
        renditionId: input.renditionId,
        targetNodeIds: [],
      });
      const planHash = sha256(stableJson({
        brief,
        outline: input.outline,
        questionDecisions: input.questionDecisions,
      }));
      const confirmationId = randomUUID();
      const now = new Date().toISOString();
      const updated = this.db.prepare(
        `UPDATE contents
         SET brief_json = ?, merchant_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(
        JSON.stringify(brief),
        brief.merchantId,
        now,
        contentId,
        input.expectedVersion,
      );
      if (updated.changes !== 1) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "内容需求已变化，请刷新后重新确认",
        });
      }
      this.db.prepare(
        `INSERT INTO authoring_confirmations(
          id, content_id, content_version, brief_json, outline_json,
          question_decisions_json, confirmed_by_message_id, plan_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        confirmationId,
        contentId,
        input.expectedVersion + 1,
        JSON.stringify(brief),
        JSON.stringify(input.outline),
        JSON.stringify(input.questionDecisions),
        confirmationMessage.id,
        planHash,
        now,
      );
      this.db.prepare(
        "UPDATE messages SET mode = 'confirm_outline', plan_id = ? WHERE id = ?",
      ).run(confirmationId, confirmationMessage.id);
      const confirmation = this.getConfirmation(confirmationId);
      return PlanViewSchema.parse({
        confirmation,
        current: true,
        messages: this.messages.list(contentId),
      });
    }).immediate();
  }

  getConfirmation(confirmationId: string): ConfirmationView {
    const row = this.db.prepare(
      `SELECT id, content_id, content_version, brief_json, outline_json,
              question_decisions_json, confirmed_by_message_id, plan_hash, created_at
       FROM authoring_confirmations WHERE id = ?`,
    ).get(confirmationId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "需求确认不存在" });
    }
    return this.toView(ConfirmationRowSchema.parse(row));
  }

  latest(contentId: string): ConfirmationView | null {
    const row = this.db.prepare(
      `SELECT id, content_id, content_version, brief_json, outline_json,
              question_decisions_json, confirmed_by_message_id, plan_hash, created_at
       FROM authoring_confirmations WHERE content_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(contentId);
    return row === undefined ? null : this.toView(ConfirmationRowSchema.parse(row));
  }

  isCurrent(contentId: string, confirmation: ConfirmationView): boolean {
    const content = this.requireContent(contentId);
    const latest = this.latest(contentId);
    return content.version === confirmation.contentVersion && latest?.confirmationId === confirmation.confirmationId;
  }

  requireCurrentAck(input: {
    contentId: string;
    confirmation: ConfirmationView;
    acknowledgement: {
      confirmationId: string;
      contentVersion: number;
      planHash: string;
      messageId: string;
    } | null;
  }): void {
    if (this.isCurrent(input.contentId, input.confirmation)) return;
    if (input.acknowledgement === null) {
      throw new ApiError({
        statusCode: 409,
        code: "PLAN_ACK_REQUIRED",
        message: "候选基于已变更的旧需求，必须由用户明确确认继续",
        details: {
          confirmationId: input.confirmation.confirmationId,
          contentVersion: input.confirmation.contentVersion,
          planHash: input.confirmation.planHash,
        },
      });
    }
    const ack = input.acknowledgement;
    if (
      ack.confirmationId !== input.confirmation.confirmationId ||
      ack.contentVersion !== input.confirmation.contentVersion ||
      ack.planHash !== input.confirmation.planHash
    ) {
      throw new ApiError({
        statusCode: 422,
        code: "PLAN_ACK_REQUIRED",
        message: "旧需求确认信息不匹配",
      });
    }
    this.messages.requireUserMessage(input.contentId, ack.messageId);
  }

  private validateQuestions(
    contentId: string,
    questions: readonly string[],
    decisions: readonly z.infer<typeof QuestionDecisionSchema>[],
  ): void {
    if (decisions.length !== questions.length) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "每个未解决问题都必须有决策，不能丢弃或合并问题",
      });
    }
    const byIndex = new Map(decisions.map((decision) => [decision.index, decision]));
    for (const [index, originalText] of questions.entries()) {
      const decision = byIndex.get(index);
      if (decision === undefined || decision.originalText !== originalText) {
        throw new ApiError({
          statusCode: 422,
          code: "VALIDATION_ERROR",
          message: "问题决策必须按 index 和原文逐项对应",
          details: { index, originalText },
        });
      }
      if (decision.action === "continue_with_gap") {
        this.messages.requireUserMessage(contentId, decision.messageId);
      }
    }
  }

  private requireContent(contentId: string): z.infer<typeof ContentRowSchema> {
    const row = this.db.prepare(
      `SELECT c.id, c.brief_json, c.version, r.kind
       FROM contents c
       JOIN renditions r ON r.content_id = c.id
       WHERE c.id = ? ORDER BY r.created_at, r.id LIMIT 1`,
    ).get(contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "内容不存在" });
    }
    return ContentRowSchema.parse(row);
  }

  private toView(row: z.infer<typeof ConfirmationRowSchema>): ConfirmationView {
    return ConfirmationViewSchema.parse({
      confirmationId: row.id,
      contentId: row.content_id,
      contentVersion: row.content_version,
      brief: JSON.parse(row.brief_json) as unknown,
      outline: JSON.parse(row.outline_json) as unknown,
      questionDecisions: JSON.parse(row.question_decisions_json) as unknown,
      confirmedByMessageId: row.confirmed_by_message_id,
      planHash: row.plan_hash,
      createdAt: row.created_at,
    });
  }
}
