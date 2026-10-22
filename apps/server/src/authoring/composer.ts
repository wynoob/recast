import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { BlobStore } from "@dmall/storage";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ChoicePatchSchema, CompositionIntentSchema, CompositionRecommendationSchema, CompositionViewSchema,
  ConfirmCommandSchema, DeliveryIntentSchema, DeliveryTargetSchema, ErrorCodeSchema, EvidenceSummarySchema,
  FixedEvidenceSchema, HardFiltersSchema, JobInputSchema, ProposalSchema, ResumeCommandSchema,
  SubmitCommandSchema, TemplatePackageSchema, WholeDraftSchema,
  type CommandIdentity, type CompositionTask, type CompositionView, type ConfirmCommand,
  type FixedEvidence, type JobInput, type Proposal, type ResumeCommand, type SubmitCommand,
} from "@dmall/contracts";
import type { ContentRepository } from "../content-repository.js";
import type { AuthoringEvidenceService } from "../authoring-evidence.js";
import type { RetrievalService } from "../retrieval/retrieval-service.js";
import type { JobRepository, JobRow } from "../job-repository.js";
import type { OutputRepository } from "../outputs/output-repository.js";
import { ApiError } from "../errors.js";
import { PlanService } from "./plans.js";
import type { MessageService } from "./messages.js";
import type { GenerationInputService } from "./generation-inputs.js";
import type { CandidateService } from "./candidates.js";
import type { CandidateAcceptService } from "./accept.js";
import type { RevisionRepository } from "./revisions.js";
import type { ProviderJournal } from "./provider-journal.js";
import { requireProvider } from "./provider-routes.js";
import { compileCompositionDraft } from "./composition-draft.js";
import { sha256, stableJson } from "./revision-commit.js";

const ContextSchema = z.strictObject({
  idea: z.string(), instructions: z.array(z.string()), delivery: DeliveryTargetSchema, choices: ChoicePatchSchema,
  includedEvidence: z.array(FixedEvidenceSchema), assertions: z.array(FixedEvidenceSchema),
  renditionId: z.uuid(), emptyBaseRevisionId: z.uuid(),
});
const CandidateSetSchema = z.strictObject({
  intent: CompositionIntentSchema,
  templates: z.array(z.strictObject({ versionId: z.uuid(), packageHash: z.string(), package: TemplatePackageSchema })),
  evidence: z.array(FixedEvidenceSchema), summaries: z.array(EvidenceSummarySchema),
  gaps: z.array(z.strictObject({ key: z.string(), question: z.string(), blocksGeneration: z.boolean() })),
});
const FailureSchema = z.strictObject({ code: ErrorCodeSchema, message: z.string() });
const CommandReceiptSchema = z.strictObject({ requestHash: z.string(), view: CompositionViewSchema });
type CompositionJob = Extract<JobInput, { jobType: "composition_provider" }>;

export class Composer {
  private readonly inFlight = new Map<string, Promise<void>>();
  private scanCursor = "";

  constructor(private readonly deps: {
    db: Database.Database; blobs: BlobStore; contents: ContentRepository; jobs: JobRepository; plans: PlanService;
    evidence: AuthoringEvidenceService; retrieval: RetrievalService; messages: MessageService;
    inputs: GenerationInputService; candidates: CandidateService; accept: CandidateAcceptService;
    revisions: RevisionRepository; journal: ProviderJournal; outputs: OutputRepository;
  }) {}

  async submit(commandValue: SubmitCommand, identity: CommandIdentity): Promise<CompositionView> {
    const command = SubmitCommandSchema.parse(commandValue);
    return this.deps.db.transaction(() => {
      const replay = this.commandReplay(identity);
      if (replay !== null) return replay;
      let contentId: string;
      let version: number;
      let context: z.infer<typeof ContextSchema>;
      if (command.mode === "create") {
        requireProvider(this.deps.db, "text");
        const content = this.deps.contents.create({ schemaVersion: 1, title: command.idea.slice(0, 200), kind: command.delivery.kind },
          { routeScope: "composition:create-content", key: identity.id, requestHash: identity.requestHash, requestId: identity.id });
        const rendition = content.renditions[0];
        if (rendition === undefined) throw new Error("新创作缺少空稿分支");
        contentId = content.id;
        version = content.version;
        context = ContextSchema.parse({ idea: command.idea, instructions: [], delivery: command.delivery, choices: command.choices ?? {},
          includedEvidence: [], assertions: [], renditionId: rendition.id, emptyBaseRevisionId: rendition.currentRevisionId });
      } else {
        contentId = command.contentId;
        const content = this.content(contentId);
        if (this.deps.plans.composition(contentId) !== null) throw fail("COMPOSITION_CONFIRMED", "创作已确认，不能继续调整", 409);
        if (content.version !== command.expectedVersion) throw new ApiError({ statusCode: 409, code: "COMPOSITION_CONFLICT", message: "其他窗口已调整方案，请刷新", details: { currentVersion: content.version } });
        context = this.context(this.intentJob(contentId, content.version));
        const choices = { ...context.choices, ...command.choices };
        if (command.instruction === undefined && stableJson(choices) === stableJson(context.choices)) throw fail("VALIDATION_ERROR", "调整没有改变要求或选择");
        context = { ...context, choices, instructions: command.instruction === undefined ? context.instructions : [...context.instructions, command.instruction] };
        const changed = this.deps.db.prepare("UPDATE contents SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
          .run(new Date().toISOString(), contentId, content.version);
        if (changed.changes !== 1) throw fail("COMPOSITION_CONFLICT", "创作版本已变化", 409);
        version = content.version + 1;
      }
      // Resolve explicit handles on every command so an index switch cannot silently reuse one.
      context.includedEvidence = (context.choices.selection?.includeHandles ?? []).flatMap((handle) => {
        this.deps.retrieval.getSelection(handle);
        return this.deps.evidence.select(contentId, [handle]);
      });
      const excluded = new Set(context.choices.selection?.excludeEvidenceIds ?? []);
      const excludedIdentities = new Set(this.deps.evidence.list(contentId).filter((item) => excluded.has(item.evidenceId)).map(evidenceIdentity));
      if (context.includedEvidence.some((item) => excluded.has(item.evidenceId) || excludedIdentities.has(evidenceIdentity(item)))) throw fail("VALIDATION_ERROR", "纳入与排除的素材不能重叠");
      if (context.choices.templateVersionId !== undefined) this.readyTemplate(context.choices.templateVersionId, context.delivery.kind);
      const statement = command.mode === "create" ? command.idea : command.instruction;
      if (statement !== undefined) context.assertions.push(this.userAssertion(contentId, context.renditionId, statement));
      const job = this.createJob({ contentId, contentVersion: version, renditionId: context.renditionId, inputId: null, task: "intent",
        businessKey: `composition:submit:${identity.id}`, payload: { context },
        guidance: "提取用户用途、受众、约束、检索词和缺口。merchantId 只能使用输入商家目录的现有 ID，不能猜归属。用户陈述不等于核实事实。",
      });
      const view = CompositionViewSchema.parse({ contentId, version, progress: this.progress(job.snapshot.id), state: "planning", step: "intent" });
      this.saveReceipt(job, `composition-command:${identity.id}`, { requestHash: identity.requestHash, view });
      return view;
    }).immediate();
  }

  async confirm(commandValue: ConfirmCommand, identity: CommandIdentity): Promise<CompositionView> {
    const command = ConfirmCommandSchema.parse(commandValue);
    return this.deps.db.transaction(() => {
      const replay = this.commandReplay(identity);
      if (replay !== null) return replay;
      const proposal = this.deps.plans.proposal(command.proposalId);
      if (proposal.hash !== command.proposalHash) throw fail("PROPOSAL_STALE", "方案 hash 不匹配", 409);
      const prior = this.deps.plans.composition(proposal.contentId);
      if (prior !== null) {
        if (prior.proposal.id !== proposal.id || prior.proposal.hash !== proposal.hash) throw fail("COMPOSITION_CONFIRMED", "创作已确认其他方案", 409);
        const job = this.requireBusinessJob(`composition:write:${prior.confirmationId}`);
        const view = this.view(proposal.contentId);
        this.saveReceipt(job, `composition-command:${identity.id}`, { requestHash: identity.requestHash, view });
        return view;
      }
      const content = this.content(proposal.contentId);
      if (content.version !== proposal.basedOnVersion) throw fail("PROPOSAL_STALE", "方案已被调整，请确认当前方案", 409);
      if (proposal.gaps.some((gap) => gap.blocksGeneration)) throw fail("COMPOSITION_GAPS", "方案仍有影响生成的缺口");
      const intent = this.intentJob(proposal.contentId, proposal.basedOnVersion);
      const context = this.context(intent);
      const candidates = CandidateSetSchema.parse(this.receipt(intent, "composition:candidates"));
      const template = this.readyTemplate(proposal.template.versionId, proposal.delivery.kind);
      if (template.packageHash !== proposal.template.packageHash) throw fail("PROPOSAL_STALE", "模板包已变化", 409);
      const ids = new Set(proposal.evidence.map((item) => item.id));
      const fixedEvidence = candidates.evidence.filter((item) => ids.has(item.evidenceId));
      this.validateEvidence(fixedEvidence, candidates.intent, context, true);
      this.requireEmptyBaseline(context);
      const fixed = this.deps.plans.confirmComposition({ proposal, templatePackage: template.package, fixedEvidence,
        renditionId: context.renditionId, emptyBaseRevisionId: context.emptyBaseRevisionId, merchantId: candidates.intent.merchantId });
      const generation = this.deps.inputs.create(proposal.contentId, fixed.renditionId, {
        schemaVersion: 1, baseRevisionId: fixed.emptyBaseRevisionId, confirmationId: fixed.confirmationId,
        templateVersionId: proposal.template.versionId, targetNodeIds: [this.rootNode(fixed.renditionId)],
        selectedEvidenceIds: fixed.fixedEvidence.map((item) => item.evidenceId), unplacedOwnerMap: {},
      });
      const job = this.createJob({ contentId: proposal.contentId, contentVersion: fixed.confirmedContentVersion,
        renditionId: fixed.renditionId, inputId: generation.id, task: proposal.delivery.kind === "feishu_doc" ? "write_doc" : "write_deck",
        businessKey: `composition:write:${fixed.confirmationId}`, payload: { proposal, templatePackage: fixed.templatePackage, evidence: fixed.fixedEvidence,
          idea: context.idea, instructions: context.instructions },
        guidance: "按已确认方案撰写完整业务正文。严格保持标题、章节或页面 key 与顺序。仅引用固定 evidenceId；不得创建内部 UUID、来源定位或未确认事实。模板 purpose 和填空指导不是正文。数字必须有来源或明示缺口，用户陈述不代表核实。",
      });
      const view = CompositionViewSchema.parse({ contentId: proposal.contentId, version: fixed.confirmedContentVersion, progress: this.progress(job.snapshot.id), state: "working", confirmationId: fixed.confirmationId, step: "writing" });
      this.saveReceipt(job, `composition-command:${identity.id}`, { requestHash: identity.requestHash, view });
      return view;
    }).immediate();
  }

  async read(contentId: string): Promise<CompositionView> { return this.view(contentId); }

  async resumeDelivery(commandValue: ResumeCommand, identity: CommandIdentity): Promise<CompositionView> {
    const command = ResumeCommandSchema.parse(commandValue);
    const fixed = this.deps.plans.composition(command.contentId);
    if (fixed === null) throw fail("JOB_NOT_RESUMABLE", "创作尚无固定交付", 409);
    const job = this.requireBusinessJob(`composition:write:${fixed.confirmationId}`);
    const intent = DeliveryIntentSchema.parse(this.receipt(job, "composition:delivery"));
    if (intent.exportId !== command.expectedExportId) throw fail("DELIVERY_IDENTITY_CONFLICT", "恢复请求不是原交付", 409);
    const preparationKey = `composition:prepare:${identity.id}`;
    const preparation = this.receipt(job, preparationKey);
    if (preparation !== null && stableJson(preparation) !== stableJson({ command, requestHash: identity.requestHash })) throw fail("IDEMPOTENCY_CONFLICT", "恢复动作键对应不同请求", 409);
    const exists = this.deps.db.prepare("SELECT id FROM exports WHERE id = ?").get(intent.exportId);
    if (preparation !== null && exists !== undefined) return this.view(command.contentId);
    if (exists === undefined) {
      if (command.expectedDecisionVersion !== 0 || command.decision.kind !== "retry_original") throw fail("JOB_NOT_RESUMABLE", "输出尚未创建，不能绑定远端结果", 409);
      this.saveReceipt(job, preparationKey, { command, requestHash: identity.requestHash });
      await this.deliver(intent);
    } else {
      await this.deps.outputs.resumeForComposition({ exportId: intent.exportId, expectedDecisionVersion: command.expectedDecisionVersion,
        decision: command.decision, commandId: identity.id, requestHash: identity.requestHash });
    }
    return this.view(command.contentId);
  }

  advance(contentId: string): Promise<void> {
    const active = this.inFlight.get(contentId);
    if (active !== undefined) return active;
    const work = this.advanceOne(contentId).finally(() => this.inFlight.delete(contentId));
    this.inFlight.set(contentId, work);
    return work;
  }

  async sweep(limit = 25): Promise<void> {
    const rows = z.array(z.object({ content_id: z.uuid() })).parse(this.deps.db.prepare(`SELECT DISTINCT json_extract(input_json, '$.contentId') AS content_id
      FROM jobs WHERE type = 'composition_provider' AND json_extract(input_json, '$.contentId') > ? ORDER BY content_id LIMIT ?`).all(this.scanCursor, limit));
    this.scanCursor = rows.length < limit ? "" : rows[rows.length - 1]!.content_id;
    for (const row of rows) await this.advance(row.content_id);
  }

  private async advanceOne(contentId: string): Promise<void> {
    const content = this.content(contentId);
    const fixed = this.deps.plans.composition(contentId);
    if (fixed === null) {
      const intentJob = this.intentJob(contentId, content.version);
      if (this.deps.plans.currentProposal(contentId, content.version) !== null) return;
      const recommend = this.deps.jobs.findBusinessKey(`composition:recommend:${intentJob.snapshot.id}`);
      const job = recommend ?? intentJob;
      if (this.receipt(job, "composition:error") !== null) return;
      try {
        const result = this.effectiveResult(job);
        if (result === null) return;
        this.deps.db.transaction(() => {
          if (this.content(contentId).version !== content.version || this.deps.plans.composition(contentId) !== null) return;
          if (result.response.task === "intent") {
            const context = this.context(intentJob);
            const candidates = this.retrieve(contentId, context, result.response.value);
            this.saveReceipt(intentJob, "composition:candidates", candidates);
            if (candidates.templates.length === 0) throw fail("TEMPLATE_NOT_READY", "没有可用的同类型模板，请先准备模板", 409);
            this.createJob({ contentId, contentVersion: content.version, renditionId: context.renditionId, inputId: null, task: "recommend",
              businessKey: `composition:recommend:${intentJob.snapshot.id}`, payload: { context, candidates },
              guidance: "仅从固定模板及证据候选中推荐，不得创建候选 ID。保持明确选择，排除项不可回流。跨商家只能使用明确授权的 comparison/reference，用 placements.use 标明。返回完整章节或页序、理由、素材安排和缺口。",
            });
          } else if (result.response.task === "recommend") {
            const candidates = CandidateSetSchema.parse(this.receipt(intentJob, "composition:candidates"));
            const context = this.context(intentJob);
            const proposal = this.recommendation(contentId, content.version, context, candidates, result.response.value);
            this.deps.plans.saveProposal(proposal, job.snapshot.id);
          }
        }).immediate();
      } catch (error) { this.recordFailure(job, error); }
      return;
    }
    const job = this.requireBusinessJob(`composition:write:${fixed.confirmationId}`);
    let delivery = this.receipt(job, "composition:delivery");
    if (delivery === null) {
      if (this.receipt(job, "composition:error") !== null) return;
      try {
        const result = this.effectiveResult(job);
        if (result === null) return;
        if (result.response.task !== "write_doc" && result.response.task !== "write_deck") throw fail("MODEL_SCHEMA_INVALID", "写作任务返回错误分支");
        const body = result.response.value;
        delivery = this.deps.db.transaction(() => {
          const existing = this.receipt(job, "composition:delivery");
          if (existing !== null) return existing;
          if (job.input.jobType !== "composition_provider" || job.input.inputId === null) throw fail("COMPOSITION_CONFLICT", "写作任务缺少固定输入", 409);
          const generation = this.deps.inputs.require(job.input.inputId);
          const compiled = compileCompositionDraft({ body, proposal: fixed.proposal,
            templatePackage: fixed.templatePackage, evidence: fixed.fixedEvidence, rootNodeId: generation.rootNodeId,
            baseAst: this.deps.revisions.viewById(fixed.emptyBaseRevisionId).ast, generationInputId: generation.id });
          const candidate = this.deps.candidates.create(fixed.renditionId, { schemaVersion: 1, inputId: generation.id, expectedRevisionId: fixed.emptyBaseRevisionId,
            operations: compiled.operations, claims: compiled.claims, modelRunId: job.snapshot.id });
          const accepted = this.deps.accept.acceptComposition(fixed, candidate.id);
          const value = { confirmationId: fixed.confirmationId, contentId, renditionId: fixed.renditionId,
            revisionId: accepted.revision.id, target: fixed.proposal.delivery, exportId: randomUUID(), outputJobId: randomUUID(),
            businessKey: `composition:delivery:${fixed.confirmationId}` };
          const intent = DeliveryIntentSchema.parse({ ...value, requestHash: sha256(stableJson(value)) });
          this.saveReceipt(job, "composition:delivery", intent);
          return intent;
        }).immediate();
      } catch (error) { this.recordFailure(job, error); return; }
    }
    const intent = DeliveryIntentSchema.parse(delivery);
    if (this.deps.db.prepare("SELECT id FROM exports WHERE id = ?").get(intent.exportId) !== undefined) return;
    // Preparation may involve files or network; never run it inside the revision transaction.
    if (this.receipt(job, "composition:delivery-error") !== null) return;
    try { await this.deliver(intent); } catch (error) { this.recordFailure(job, error, "composition:delivery-error"); }
  }

  private effectiveResult(job: JobRow) {
    if (job.snapshot.cancelRequested || job.snapshot.state === "running" || job.snapshot.state === "cancelled") return null;
    const result = this.deps.journal.compositionResult(job.snapshot.id);
    if (result?.jobType !== "composition_provider") return null;
    if (job.snapshot.state !== "succeeded") this.deps.jobs.completeRecovered(job.snapshot.id, result);
    return result;
  }

  private async deliver(intent: z.infer<typeof DeliveryIntentSchema>): Promise<void> {
    await this.deps.outputs.createForComposition({ contentId: intent.contentId, renditionId: intent.renditionId,
      revisionId: intent.revisionId, target: intent.target, exportId: intent.exportId, jobId: intent.outputJobId,
      businessKey: intent.businessKey, requestHash: intent.requestHash });
  }

  private retrieve(contentId: string, context: z.infer<typeof ContextSchema>, intent: z.infer<typeof CompositionIntentSchema>): z.infer<typeof CandidateSetSchema> {
    const rows = z.array(z.object({ id: z.uuid() })).parse(this.deps.db.prepare(`SELECT id FROM template_versions WHERE kind = ? AND status = 'ready' AND package_json IS NOT NULL ORDER BY created_at DESC LIMIT 30`).all(context.delivery.kind));
    const templates = context.choices.templateVersionId === undefined
      ? rows.map((row) => this.readyTemplate(row.id, context.delivery.kind))
      : [this.readyTemplate(context.choices.templateVersionId, context.delivery.kind)];
    const known = this.deps.evidence.list(contentId);
    const byIdentity = new Map(known.map((item) => [evidenceIdentity(item), item]));
    const allEvidence = new Map(context.includedEvidence.map((item) => [evidenceIdentity(item), item]));
    const gaps = [...intent.gaps];
    const allowedMerchants = [intent.merchantId, ...(context.choices.crossMerchantUse ?? []).map((item) => item.merchantId)].filter((id) => id !== null);
    for (const [termIndex, term] of intent.searchTerms.entries()) {
      const found = this.deps.retrieval.search({ schemaVersion: 1, query: term, mode: "keyword", limit: 20,
        filters: HardFiltersSchema.parse({ schemaVersion: 1, availability: ["available"] }) },
        { scope: `composition:search:${contentId}:${this.content(contentId).version}:${termIndex}`, key: randomUUID(), requestId: randomUUID() });
      for (const hit of found.hits) {
        const merchant = this.selectionMerchant(hit.selectionHandle);
        if (merchant === null || !allowedMerchants.includes(merchant)) {
          if (merchant === null && hit.refType === "fact") gaps.push({ key: `ownership:${hit.refId}`, question: "候选事实缺少商家归属，需补充后才能用于业务结论", blocksGeneration: true });
          continue;
        }
        for (const item of this.deps.evidence.select(contentId, [hit.selectionHandle])) {
          const key = evidenceIdentity(item);
          allEvidence.set(key, byIdentity.get(key) ?? item);
        }
      }
    }
    for (const assertion of context.assertions) allEvidence.set(evidenceIdentity(assertion), assertion);
    const excluded = new Set(context.choices.selection?.excludeEvidenceIds ?? []);
    const excludedIdentities = new Set(known.filter((item) => excluded.has(item.evidenceId)).map(evidenceIdentity));
    const evidence = [...allEvidence.values()].filter((item) => !excluded.has(item.evidenceId) && !excludedIdentities.has(evidenceIdentity(item)));
    this.validateEvidence(context.includedEvidence, intent, context, false);
    if (evidence.every((item) => item.kind === "user_assertion")) gaps.push({ key: "no_evidence", question: "未找到有明确归属的可用素材；本稿仅使用用户陈述，省略未经核实的业务数字", blocksGeneration: false });
    return CandidateSetSchema.parse({ intent, templates, evidence, summaries: evidence.map((item) => this.summary(item)), gaps });
  }

  private recommendation(contentId: string, version: number, context: z.infer<typeof ContextSchema>, candidates: z.infer<typeof CandidateSetSchema>, value: z.infer<typeof CompositionRecommendationSchema>): Proposal {
    if (value.kind !== context.delivery.kind) throw fail("MODEL_SCHEMA_INVALID", "推荐交付类型与用户选择不一致");
    const template = candidates.templates.find((item) => item.versionId === value.templateVersionId);
    if (template === undefined) throw fail("UNKNOWN_REFERENCE", "模型推荐了固定候选之外的模板");
    const ids = new Set(value.evidenceIds);
    if (ids.size !== value.evidenceIds.length || value.evidenceIds.some((id) => !candidates.evidence.some((item) => item.evidenceId === id))) throw fail("UNKNOWN_REFERENCE", "模型推荐了固定候选之外的证据");
    if (context.includedEvidence.some((item) => !ids.has(item.evidenceId))) throw fail("UNKNOWN_REFERENCE", "推荐遗漏用户明确纳入的素材");
    const containers = value.kind === "feishu_doc" ? value.sections : value.slides;
    if (new Set(containers.map((item) => item.key)).size !== containers.length) throw fail("MODEL_SCHEMA_INVALID", "方案章节或页面 key 重复");
    const expected = value.kind === "feishu_doc" ? template.package.narrative.doc.sections : template.package.narrative.deck.slides;
    if (containers.length !== expected.length || containers.some((item, index) => item.templateContainerKey !== expected[index]?.id)) throw fail("TEMPLATE_INVALID", "方案必须覆盖固定模板的章节或页序");
    for (const container of containers) {
      if ("layoutKey" in container) {
        const layout = template.package.narrative.deck.slides.find((item) => item.id === container.templateContainerKey);
        if (layout?.layout !== container.layoutKey) throw fail("TEMPLATE_INVALID", "方案页面使用了错误版式");
      }
      for (const placement of container.placements) {
        if (!ids.has(placement.evidenceId)) throw fail("UNKNOWN_REFERENCE", "素材安排使用了未选择的证据");
        const summary = candidates.summaries.find((item) => item.id === placement.evidenceId);
        if (summary?.merchantId !== null && summary?.merchantId !== candidates.intent.merchantId && summary?.kind !== "user_assertion") {
          const authorization = context.choices.crossMerchantUse?.find((item) => item.merchantId === summary?.merchantId);
          if (authorization === undefined || placement.use !== authorization.purpose) throw fail("UNKNOWN_REFERENCE", "跨商家素材必须标明授权的对比或借鉴用途");
        }
        if ("templateSlotKey" in placement && !template.package.slots.some((slot) => slot.id === placement.templateSlotKey && slot.containerId === container.templateContainerKey)) throw fail("TEMPLATE_INVALID", "素材安排使用错误模板槽位");
      }
    }
    const common = { id: randomUUID(), contentId, basedOnVersion: version, title: value.title, purpose: candidates.intent.purpose, audience: candidates.intent.audience,
      template: { versionId: template.versionId, packageHash: template.packageHash, reason: value.reason },
      evidence: candidates.summaries.filter((item) => ids.has(item.id)), gaps: [...candidates.gaps, ...value.gaps] };
    const proposal = value.kind === "feishu_doc" && context.delivery.kind === "feishu_doc"
      ? { ...common, delivery: context.delivery, sections: value.sections }
      : value.kind === "html_deck" ? { ...common, delivery: { kind: "html_deck" }, slides: value.slides } : null;
    return ProposalSchema.parse({ ...proposal, hash: sha256(stableJson(proposal)) });
  }

  private view(contentId: string): CompositionView {
    const content = this.content(contentId);
    const fixed = this.deps.plans.composition(contentId);
    if (fixed === null) {
      const intent = this.intentJob(contentId, content.version);
      const proposal = this.deps.plans.currentProposal(contentId, content.version);
      const recommend = this.deps.jobs.findBusinessKey(`composition:recommend:${intent.snapshot.id}`);
      const job = recommend ?? intent;
      const common = { contentId, version: content.version, progress: this.progress(job.snapshot.id) };
      if (proposal !== null) return CompositionViewSchema.parse({ ...common, state: "proposed", proposal });
      const error = this.failure(job);
      if (error !== null) return CompositionViewSchema.parse({ ...common, state: "blocked", step: "planning", ...error, actions: [{ kind: "adjust" }, ...(error.code === "MODEL_CAPABILITY_MISSING" ? [{ kind: "configure", capability: "text" }] : [])], availableRevisionId: null });
      return CompositionViewSchema.parse({ ...common, state: "planning", step: recommend === null ? "intent" : "recommend" });
    }
    const job = this.requireBusinessJob(`composition:write:${fixed.confirmationId}`);
    const common = { contentId, version: content.version, progress: this.progress(job.snapshot.id) };
    const receipt = this.receipt(job, "composition:delivery");
    if (receipt === null) {
      const error = this.failure(job);
      if (error !== null) return CompositionViewSchema.parse({ ...common, state: "blocked", step: job.snapshot.state === "succeeded" ? "accepting" : "writing", ...error,
        actions: [{ kind: "new_composition" }, ...(error.code === "MODEL_CAPABILITY_MISSING" ? [{ kind: "configure", capability: "text" }] : [])], availableRevisionId: null });
      return CompositionViewSchema.parse({ ...common, state: "working", confirmationId: fixed.confirmationId, step: job.snapshot.state === "succeeded" ? "accepting" : "writing" });
    }
    const intent = DeliveryIntentSchema.parse(receipt);
    const exists = this.deps.db.prepare("SELECT id FROM exports WHERE id = ?").get(intent.exportId);
    if (exists === undefined) {
      const error = this.receipt(job, "composition:delivery-error");
      if (error !== null) return CompositionViewSchema.parse({ ...common, state: "blocked", step: "preparing", ...FailureSchema.parse(error),
        actions: [...(FailureSchema.parse(error).code === "FEISHU_AUTH_MISSING" ? [{ kind: "configure", capability: "feishu" }] : []), { kind: "resume_delivery", exportId: intent.exportId, decisionVersion: 0 }], availableRevisionId: intent.revisionId });
      return CompositionViewSchema.parse({ ...common, state: "working", confirmationId: fixed.confirmationId, step: "preparing" });
    }
    const output = this.deps.outputs.get(intent.exportId);
    const outputJob = this.deps.jobs.get(output.jobId);
    const progress = this.progress(output.jobId);
    if (output.status === "succeeded") {
      if (intent.target.kind === "feishu_doc" && output.remoteDocumentId !== null && output.remoteUrl !== null && output.feishuBindingId !== null) {
        return CompositionViewSchema.parse({ ...common, progress, state: "delivered", result: { kind: "feishu_doc", exportId: output.id, revisionId: intent.revisionId, documentId: output.remoteDocumentId, url: output.remoteUrl } });
      }
      const zip = output.artifacts.find((item) => item.kind === "html_zip");
      if (intent.target.kind === "html_deck" && zip !== undefined) return CompositionViewSchema.parse({ ...common, progress, state: "delivered", result: { kind: "html_deck", exportId: output.id, revisionId: intent.revisionId, previewUrl: `/api/v1/exports/${output.id}/preview/index.html`, zip } });
    }
    if (outputJob !== null && ["failed", "partial", "waiting_input", "cancelled", "succeeded"].includes(outputJob.snapshot.state)) {
      const decision = this.deps.db.prepare("SELECT decision_version FROM output_job_decisions WHERE job_id = ?").get(output.jobId);
      const decisionVersion = decision === undefined ? 0 : z.object({ decision_version: z.int() }).parse(decision).decision_version;
      const unknown = this.deps.db.prepare("SELECT operation_id FROM remote_operations WHERE job_id = ? AND kind = 'feishu_create_document' AND state IN ('dispatched', 'unknown') ORDER BY created_at DESC LIMIT 1").get(output.jobId);
      const knownDocument = outputJob.snapshot.checkpoint?.jobType === "feishu_publish" ? outputJob.snapshot.checkpoint.documentId : null;
      const operationId = unknown === undefined || knownDocument !== null ? null : z.object({ operation_id: z.string() }).parse(unknown).operation_id;
      const actions: Array<z.infer<typeof import("@dmall/contracts").AllowedActionSchema>> = [];
      if (operationId !== null && intent.target.kind === "feishu_doc") actions.push({ kind: "verify_remote", exportId: intent.exportId, operationId, decisionVersion });
      else if (!outputJob.snapshot.cancelRequested && outputJob.snapshot.state !== "succeeded") actions.push({ kind: "resume_delivery", exportId: intent.exportId, decisionVersion });
      if (outputJob.snapshot.error?.code === "FEISHU_AUTH_MISSING") actions.push({ kind: "configure", capability: "feishu" });
      return CompositionViewSchema.parse({ ...common, progress, state: "blocked", step: "delivering", code: outputJob.snapshot.error?.code ?? (operationId !== null ? "REMOTE_RESULT_UNKNOWN" : "JOB_NOT_RESUMABLE"), message: outputJob.snapshot.error?.message ?? "输出尚未完整交付", actions, availableRevisionId: intent.revisionId });
    }
    return CompositionViewSchema.parse({ ...common, progress, state: "working", confirmationId: fixed.confirmationId, step: "delivering" });
  }

  private createJob(input: { contentId: string; contentVersion: number; renditionId: string; inputId: string | null; task: CompositionTask; businessKey: string; payload: unknown; guidance: string }): JobRow {
    const provider = requireProvider(this.deps.db, "text");
    const schema = input.task === "intent" ? CompositionIntentSchema : input.task === "recommend" ? CompositionRecommendationSchema : input.task === "write_doc" ? WholeDraftSchema.options[0] : WholeDraftSchema.options[1];
    const responseSchemaId = { intent: "composition_intent/1", recommend: "composition_recommend/1", write_doc: "composition_doc/1", write_deck: "composition_deck/1" }[input.task];
    const merchants = this.deps.db.prepare("SELECT DISTINCT merchant_id FROM chunk_search WHERE merchant_id IS NOT NULL LIMIT 200").all();
    const jobInput = JobInputSchema.parse({ schemaVersion: 1, jobType: "composition_provider", contentId: input.contentId, contentVersion: input.contentVersion,
      renditionId: input.renditionId, inputId: input.inputId, task: input.task,
      provider: { role: "text", providerId: provider.id, baseUrl: provider.baseUrl, modelId: provider.modelId, credentialEnv: provider.credentialEnv, timeoutMs: provider.timeoutMs },
      requestEnvelope: { role: "text", providerId: provider.id, modelId: provider.modelId, providerConfigVersion: `${provider.id}:${provider.updatedAt}`, promptVersion: "composition/1", responseSchemaId,
        messages: [{ role: "system", content: `${input.guidance}\n只输出满足以下 schema 的 JSON，不输出 markdown。\n${JSON.stringify(z.toJSONSchema(schema))}` },
          { role: "user", content: JSON.stringify({ payload: input.payload, merchants }) }], toolsDisabled: true, timeoutMs: provider.timeoutMs },
    });
    const snapshot = this.deps.jobs.create({ type: "composition_provider", input: jobInput, inputHash: sha256(stableJson(jobInput)), idempotencyKey: null, businessKey: input.businessKey });
    return this.deps.jobs.get(snapshot.id)!;
  }

  private context(job: JobRow): z.infer<typeof ContextSchema> {
    const input = this.compositionInput(job);
    const user = input.requestEnvelope.messages.find((item) => item.role === "user");
    return z.object({ payload: z.object({ context: ContextSchema }) }).parse(JSON.parse(user?.content ?? "null")).payload.context;
  }

  private compositionInput(job: JobRow): CompositionJob {
    if (job.input.jobType !== "composition_provider") throw new Error("不是创作任务");
    return job.input;
  }

  private intentJob(contentId: string, version: number): JobRow {
    const raw = this.deps.db.prepare(`SELECT id FROM jobs WHERE type = 'composition_provider' AND json_extract(input_json, '$.contentId') = ? AND json_extract(input_json, '$.contentVersion') = ? AND json_extract(input_json, '$.task') = 'intent' LIMIT 1`).get(contentId, version);
    if (raw === undefined) throw fail("COMPOSITION_NOT_FOUND", "内容不属于 AI 创作，请查看只读历史", 404);
    const row = this.deps.jobs.get(z.object({ id: z.uuid() }).parse(raw).id);
    if (row === null) throw new Error("创作任务不存在");
    return row;
  }

  private requireBusinessJob(key: string): JobRow {
    const job = this.deps.jobs.findBusinessKey(key);
    if (job === null) throw new Error("创作业务任务不存在");
    return job;
  }

  private content(id: string) {
    const row = this.deps.db.prepare("SELECT id, version FROM contents WHERE id = ?").get(id);
    if (row === undefined) throw fail("COMPOSITION_NOT_FOUND", "创作不存在", 404);
    return z.object({ id: z.uuid(), version: z.int().nonnegative() }).parse(row);
  }

  private readyTemplate(id: string, kind: string) {
    const row = this.deps.db.prepare("SELECT id, kind, status, package_json, package_hash FROM template_versions WHERE id = ?").get(id);
    if (row === undefined) throw fail("UNKNOWN_REFERENCE", "模板版本不存在");
    const value = z.object({ id: z.uuid(), kind: z.string(), status: z.string(), package_json: z.string().nullable(), package_hash: z.string().nullable() }).parse(row);
    if (value.status !== "ready" || value.kind !== kind || value.package_json === null || value.package_hash === null) throw fail("TEMPLATE_NOT_READY", "模板尚不可用或类型不匹配");
    return { versionId: value.id, packageHash: value.package_hash, package: TemplatePackageSchema.parse(JSON.parse(value.package_json)) };
  }

  private selectionMerchant(handle: string): string | null {
    const selection = this.deps.retrieval.getSelection(handle);
    const row = this.deps.db.prepare("SELECT merchant_id FROM chunk_search WHERE chunk_id = ?").get(selection.chunkId);
    return row === undefined ? null : z.object({ merchant_id: z.string().nullable() }).parse(row).merchant_id;
  }

  private validateEvidence(evidence: FixedEvidence[], intent: z.infer<typeof CompositionIntentSchema>, context: z.infer<typeof ContextSchema>, confirming: boolean): void {
    for (const item of evidence) {
      if (item.kind === "user_assertion") continue;
      const summary = this.summary(item);
      const authorized = summary.merchantId !== null && (summary.merchantId === intent.merchantId || context.choices.crossMerchantUse?.some((entry) => entry.merchantId === summary.merchantId));
      if (!authorized) throw fail("UNKNOWN_REFERENCE", "所选素材缺少归属或跨商家使用授权");
      if (summary.availability !== "available") throw fail("UNKNOWN_REFERENCE", "所选证据已不可用");
      if (confirming && item.selectionHandle !== null) this.deps.retrieval.getSelection(item.selectionHandle);
      const sourceIds = item.kind === "source" ? [item.sourceVersionId] : item.kind === "fact" ? item.entity.sourceVersionIds : item.occurrence === null ? [] : [item.occurrence.sourceVersionId];
      for (const sourceId of sourceIds) {
        const source = this.deps.db.prepare("SELECT sv.snapshot_blob_hash, s.status FROM source_versions sv JOIN sources s ON s.id = sv.source_id WHERE sv.id = ?").get(sourceId);
        if (source === undefined) throw fail("UNKNOWN_REFERENCE", "固定来源已不存在");
        const value = z.object({ snapshot_blob_hash: z.string(), status: z.string() }).parse(source);
        if (value.status !== "active" || !existsSync(this.deps.blobs.pathForHash(value.snapshot_blob_hash))) throw fail("UNKNOWN_REFERENCE", "固定来源文件已不可用");
      }
      if (item.kind === "fact") {
        const fact = z.object({ merchant_id: z.string().nullable(), status: z.string() }).parse(this.deps.db.prepare("SELECT merchant_id, status FROM fact_versions WHERE id = ?").get(item.entity.factVersionId));
        if (fact.merchant_id !== item.entity.merchantId || fact.status === "obsolete") throw fail("UNKNOWN_REFERENCE", "事实归属或可用性已变化");
      }
      if (item.kind === "media") {
        const hashes = [item.blobHash, item.derivative?.blobHash, item.poster?.blobHash].filter((hash) => hash !== undefined);
        if (hashes.some((hash) => !existsSync(this.deps.blobs.pathForHash(hash)))) throw fail("UNKNOWN_REFERENCE", "固定媒体文件已缺失");
        const row = this.deps.db.prepare("SELECT a.blob_hash FROM asset_versions av JOIN assets a ON a.id = av.asset_id WHERE av.id = ? AND av.asset_id = ?").get(item.assetVersionId, item.assetId);
        if (row === undefined || z.object({ blob_hash: z.string() }).parse(row).blob_hash !== item.blobHash) throw fail("UNKNOWN_REFERENCE", "图片身份已变化");
      }
    }
  }

  private summary(item: FixedEvidence): z.infer<typeof EvidenceSummarySchema> {
    if (item.kind === "user_assertion") return EvidenceSummarySchema.parse({ id: item.evidenceId, kind: item.kind, title: item.exactText.slice(0, 120), sourceLabel: "用户提供，未独立核实", merchantId: null, availability: "available" });
    if (item.selectionHandle === null) throw fail("UNKNOWN_REFERENCE", "媒体缺少可核对来源");
    const selection = this.deps.retrieval.getSelection(item.selectionHandle);
    const row = this.deps.db.prepare("SELECT merchant_id, availability FROM chunk_search WHERE chunk_id = ?").get(selection.chunkId);
    const metadata = row === undefined ? null : z.object({ merchant_id: z.string().nullable(), availability: z.string() }).parse(row);
    return EvidenceSummarySchema.parse({ id: item.evidenceId, kind: item.kind, title: selection.sourceTitle ?? (item.kind === "fact" ? item.entity.statement : "来源素材"),
      sourceLabel: selection.sourceDocumentUrl ?? selection.sourceFileUrl ?? selection.sourceVersionId ?? "固定来源", merchantId: metadata?.merchant_id ?? null, availability: metadata?.availability === "available" ? "available" : "missing" });
  }

  private userAssertion(contentId: string, renditionId: string, text: string): FixedEvidence {
    const message = this.deps.messages.create(contentId, { schemaVersion: 1, mode: "note", text, renditionId, targetNodeIds: [] });
    const item = FixedEvidenceSchema.parse({ kind: "user_assertion", evidenceId: randomUUID(), selectionHandle: null, messageId: message.id, contentId, exactText: text, textHash: sha256(text) });
    this.deps.db.prepare("INSERT INTO authoring_evidence(id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(item.evidenceId, contentId, `user:${message.id}`, item.kind, JSON.stringify(item), sha256(text), sha256(text), new Date().toISOString());
    return item;
  }

  private rootNode(renditionId: string) {
    return z.object({ root_node_id: z.uuid() }).parse(this.deps.db.prepare("SELECT root_node_id FROM renditions WHERE id = ?").get(renditionId)).root_node_id;
  }

  private requireEmptyBaseline(context: z.infer<typeof ContextSchema>): void {
    const current = z.object({ current_revision_id: z.uuid() }).parse(this.deps.db.prepare("SELECT current_revision_id FROM renditions WHERE id = ?").get(context.renditionId));
    const base = this.deps.revisions.viewById(context.emptyBaseRevisionId);
    if (current.current_revision_id !== context.emptyBaseRevisionId || (base.ast.kind === "feishu_doc" ? base.ast.sections.length : base.ast.slides.length) !== 0) throw fail("REVISION_CONFLICT", "独占空稿已变化，不能自动覆盖", 409);
  }

  private commandReplay(identity: CommandIdentity): CompositionView | null {
    const raw = this.deps.db.prepare("SELECT result_json FROM worker_receipts WHERE receipt_key = ? LIMIT 1").get(`composition-command:${identity.id}`);
    if (raw === undefined) return null;
    const receipt = CommandReceiptSchema.parse(JSON.parse(z.object({ result_json: z.string() }).parse(raw).result_json));
    if (receipt.requestHash !== identity.requestHash) throw fail("IDEMPOTENCY_CONFLICT", "同一动作键对应不同请求", 409);
    return receipt.view;
  }

  private receipt(job: JobRow, key: string): unknown | null {
    const row = this.deps.db.prepare("SELECT input_hash, result_json FROM worker_receipts WHERE job_id = ? AND receipt_key = ?").get(job.snapshot.id, key);
    if (row === undefined) return null;
    const parsed = z.object({ input_hash: z.string(), result_json: z.string() }).parse(row);
    if (parsed.input_hash !== job.inputHash) throw fail("CALL_IDENTITY_CONFLICT", "接续凭据不属于当前输入", 409);
    return JSON.parse(parsed.result_json);
  }

  private saveReceipt(job: JobRow, key: string, value: unknown): void {
    const prior = this.receipt(job, key);
    if (prior !== null) {
      if (stableJson(prior) !== stableJson(value)) throw fail("IDEMPOTENCY_CONFLICT", "接续凭据对应不同结果", 409);
      return;
    }
    this.deps.db.prepare("INSERT INTO worker_receipts(job_id, receipt_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(job.snapshot.id, key, job.inputHash, JSON.stringify(value), new Date().toISOString());
  }

  private recordFailure(job: JobRow, error: unknown, key = "composition:error"): void {
    if (this.receipt(job, key) !== null) return;
    const failure = error instanceof ApiError ? { code: error.code, message: error.message } : { code: "DRAFT_INVALID", message: error instanceof Error ? error.message : "创作结果不符合契约" };
    this.saveReceipt(job, key, FailureSchema.parse(failure));
    this.deps.jobs.appendEventInTransaction({ jobId: job.snapshot.id, kind: "error", phase: key === "composition:delivery-error" ? "preparing" : "composition", done: null, total: null, payload: { kind: "error", ...FailureSchema.parse(failure), retryable: false } });
  }

  private failure(job: JobRow): z.infer<typeof FailureSchema> | null {
    const receipt = this.receipt(job, "composition:error");
    if (receipt !== null) return FailureSchema.parse(receipt);
    if (job.snapshot.error !== null) return { code: job.snapshot.error.code, message: job.snapshot.error.message };
    if (job.snapshot.state === "cancelled") return { code: "JOB_CANCELLED", message: "创作任务已取消" };
    return null;
  }

  private progress(jobId: string) {
    const event = this.deps.jobs.events(jobId, 0).at(-1);
    return event === undefined ? null : { jobId, seq: event.seq, phase: event.phase, done: event.done, total: event.total,
      message: "message" in event.payload ? event.payload.message : event.phase };
  }
}

function fail(code: z.infer<typeof ErrorCodeSchema>, message: string, statusCode = 422): ApiError {
  return new ApiError({ statusCode, code, message });
}

function evidenceIdentity(item: FixedEvidence): string {
  if (item.kind === "media") return `media:${item.assetVersionId}:${item.occurrence?.requestedOccurrenceId ?? ""}`;
  if (item.kind === "user_assertion") return `user:${item.messageId}`;
  return `${item.kind}:${item.entityHash}`;
}
