import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CreateGenerationInputRequestSchema,
  GenerationInputViewSchema,
  TemplatePackageSchema,
  type CreateGenerationInputRequest,
  type GenerationInputView,
  type GenerationReadiness,
} from "@dmall/contracts";
import { assertValidAst } from "@dmall/domain";
import { ApiError } from "../errors.js";
import type { AuthoringEvidenceService } from "../authoring-evidence.js";
import { PlanService } from "./plans.js";
import { sha256, stableJson } from "./revision-commit.js";

const RenditionRowSchema = z.strictObject({
  id: z.uuid(),
  content_id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  root_node_id: z.uuid(),
  current_revision_id: z.uuid(),
});

const RevisionRowSchema = z.strictObject({
  id: z.uuid(),
  ast_json: z.string(),
});

const TemplateRowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  status: z.enum(["draft", "ready", "archived"]),
  package_json: z.string(),
  package_hash: z.string(),
});

const InputRowSchema = z.strictObject({
  id: z.uuid(),
  content_id: z.uuid(),
  rendition_id: z.uuid(),
  base_revision_id: z.uuid(),
  root_node_id: z.uuid(),
  confirmation_id: z.uuid(),
  target_kind: z.enum(["feishu_doc", "html_deck"]),
  target_node_ids_json: z.string(),
  template_version_id: z.uuid(),
  template_package_json: z.string(),
  template_hash: z.string(),
  evidence_json: z.string(),
  unplaced_owner_map_json: z.string(),
  provider_config_version: z.string(),
  prompt_version: z.string(),
  schema_version: z.int(),
  input_hash: z.string(),
  created_at: z.string(),
});

export class GenerationInputService {
  private readonly plans: PlanService;

  constructor(
    private readonly db: Database.Database,
    private readonly evidence: AuthoringEvidenceService,
    plans?: PlanService,
  ) {
    this.plans = plans ?? new PlanService(db);
  }

  create(
    contentId: string,
    renditionId: string,
    request: CreateGenerationInputRequest,
  ): GenerationInputView {
    const input = CreateGenerationInputRequestSchema.parse(request);
    return this.db.transaction(() => {
      const rendition = this.requireRendition(contentId, renditionId);
      if (rendition.current_revision_id !== input.baseRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "生成输入必须固定当前修订",
          details: { currentRevisionId: rendition.current_revision_id },
        });
      }
      const base = this.requireRevision(input.baseRevisionId, renditionId);
      const ast = assertValidAst(JSON.parse(base.ast_json) as unknown);
      const confirmation = this.plans.getConfirmation(input.confirmationId);
      if (confirmation.contentId !== contentId) {
        throw new ApiError({
          statusCode: 422,
          code: "UNKNOWN_REFERENCE",
          message: "需求确认不属于该内容",
        });
      }
      const template = this.requireTemplate(input.templateVersionId);
      if (template.kind !== rendition.kind) {
        throw new ApiError({
          statusCode: 422,
          code: "TEMPLATE_INVALID",
          message: "模板类型与目标稿件不一致",
        });
      }
      if (template.status !== "ready") {
        throw new ApiError({
          statusCode: 422,
          code: "TEMPLATE_NOT_READY",
          message: "生成只能固定 ready 模板版本",
        });
      }
      const pkg = TemplatePackageSchema.parse(JSON.parse(template.package_json) as unknown);
      const nodeIds = new Set<string>([rendition.root_node_id]);
      if (ast.kind === "feishu_doc") {
        for (const section of ast.sections) {
          nodeIds.add(section.id);
          for (const block of section.blocks) nodeIds.add(block.id);
        }
      } else {
        for (const slide of ast.slides) {
          nodeIds.add(slide.id);
          for (const block of slide.blocks) nodeIds.add(block.id);
        }
      }
      for (const id of input.targetNodeIds) {
        if (!nodeIds.has(id)) {
          throw new ApiError({
            statusCode: 422,
            code: "TARGET_SCOPE_INVALID",
            message: "生成目标节点不在固定基线中",
            details: { nodeId: id },
          });
        }
      }
      const evidence = this.evidence.list(contentId, input.selectedEvidenceIds);
      const provider = this.textProviderVersion();
      const identity = {
        contentId,
        renditionId,
        baseRevisionId: input.baseRevisionId,
        rootNodeId: rendition.root_node_id,
        confirmationId: input.confirmationId,
        targetKind: rendition.kind,
        targetNodeIds: input.targetNodeIds,
        templateVersionId: input.templateVersionId,
        templateHash: template.package_hash,
        evidence,
        unplacedOwnerMap: input.unplacedOwnerMap,
        providerConfigVersion: provider,
        promptVersion: "t06-authoring/1",
        schemaVersion: 1,
      };
      const inputHash = sha256(stableJson(identity));
      const duplicate = this.db.prepare(
        "SELECT id FROM generation_inputs WHERE input_hash = ? LIMIT 1",
      ).get(inputHash);
      if (duplicate !== undefined) {
        const row = z.strictObject({ id: z.uuid() }).parse(duplicate);
        return this.require(row.id);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO generation_inputs(
          id, content_id, rendition_id, base_revision_id, root_node_id,
          confirmation_id, target_kind, target_node_ids_json, template_version_id,
          template_package_json, template_hash, evidence_json, unplaced_owner_map_json,
          provider_config_version, prompt_version, schema_version, input_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        id,
        contentId,
        renditionId,
        input.baseRevisionId,
        rendition.root_node_id,
        input.confirmationId,
        rendition.kind,
        JSON.stringify(input.targetNodeIds),
        input.templateVersionId,
        JSON.stringify(pkg),
        template.package_hash,
        JSON.stringify(evidence),
        JSON.stringify(input.unplacedOwnerMap),
        provider,
        "t06-authoring/1",
        inputHash,
        now,
      );
      return this.require(id);
    }).immediate();
  }

  require(id: string): GenerationInputView {
    const row = this.db.prepare("SELECT * FROM generation_inputs WHERE id = ?").get(id);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "生成输入不存在" });
    }
    const parsed = InputRowSchema.parse(row);
    return GenerationInputViewSchema.parse({
      id: parsed.id,
      contentId: parsed.content_id,
      renditionId: parsed.rendition_id,
      baseRevisionId: parsed.base_revision_id,
      rootNodeId: parsed.root_node_id,
      confirmationId: parsed.confirmation_id,
      targetKind: parsed.target_kind,
      targetNodeIds: JSON.parse(parsed.target_node_ids_json) as unknown,
      templateVersionId: parsed.template_version_id,
      templateHash: parsed.template_hash,
      templatePackage: JSON.parse(parsed.template_package_json) as unknown,
      evidence: JSON.parse(parsed.evidence_json) as unknown,
      unplacedOwnerMap: JSON.parse(parsed.unplaced_owner_map_json) as unknown,
      providerConfigVersion: parsed.provider_config_version,
      promptVersion: parsed.prompt_version,
      schemaVersion: 1,
      inputHash: parsed.input_hash,
      createdAt: parsed.created_at,
    });
  }

  readiness(input: GenerationInputView, forProvider: boolean): GenerationReadiness {
    const reasons: Array<Extract<GenerationReadiness, { kind: "waiting_input" }>["reasons"][number]> = [];
    if (input.templatePackage.slots.some((slot) => slot.source.kind === "brief" && slot.source.field === "durationMinutes") &&
      this.confirmationBrief(input.confirmationId).durationMinutes === null) {
      reasons.push({ kind: "duration_required", templateVersionId: input.templateVersionId });
    }
    const confirmation = this.plans.getConfirmation(input.confirmationId);
    const decisions = new Map(confirmation.questionDecisions.map((decision) => [decision.index, decision]));
    for (const [index, originalText] of confirmation.brief.unresolvedQuestions.entries()) {
      if (decisions.get(index)?.action !== "continue_with_gap") {
        reasons.push({ kind: "unresolved_question", questionIndex: index, originalText });
      }
    }
    if (forProvider && this.textProviderVersion() === "unconfigured") {
      reasons.push({ kind: "capability", role: "text", state: "unconfigured" });
    }
    const unplaced = Object.keys(input.unplacedOwnerMap);
    if (unplaced.length > 0) {
      const existing = this.nodeIds(input.baseRevisionId);
      const missing = unplaced.filter((blockId) => !existing.has(blockId) || !existing.has(input.unplacedOwnerMap[blockId]!));
      if (missing.length > 0) {
        reasons.push({ kind: "unplaced_owner_required", blockIds: missing });
      }
    }
    return reasons.length === 0 ? { kind: "ready" } : { kind: "waiting_input", reasons };
  }

  private confirmationBrief(confirmationId: string) {
    return this.plans.getConfirmation(confirmationId).brief;
  }

  private textProviderVersion(): string {
    const row = this.db.prepare(
      "SELECT id, updated_at FROM provider_configs WHERE role = 'text' LIMIT 1",
    ).get();
    if (row === undefined) return "unconfigured";
    const parsed = z.strictObject({ id: z.uuid(), updated_at: z.string() }).parse(row);
    return `${parsed.id}:${parsed.updated_at}`;
  }

  private requireRendition(contentId: string, renditionId: string): z.infer<typeof RenditionRowSchema> {
    const row = this.db.prepare(
      "SELECT id, content_id, kind, root_node_id, current_revision_id FROM renditions WHERE id = ? AND content_id = ?",
    ).get(renditionId, contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "稿件分支不存在" });
    }
    return RenditionRowSchema.parse(row);
  }

  private requireRevision(revisionId: string, renditionId: string): z.infer<typeof RevisionRowSchema> {
    const row = this.db.prepare(
      "SELECT id, ast_json FROM revisions WHERE id = ? AND rendition_id = ?",
    ).get(revisionId, renditionId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "修订不存在" });
    }
    return RevisionRowSchema.parse(row);
  }

  private requireTemplate(id: string): z.infer<typeof TemplateRowSchema> {
    const row = this.db.prepare(
      `SELECT id, kind, status, package_json, package_hash
       FROM template_versions WHERE id = ?`,
    ).get(id);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "模板版本不存在或缺少固定包" });
    }
    const parsed = TemplateRowSchema.parse(row);
    return parsed;
  }

  private nodeIds(revisionId: string): Set<string> {
    const row = z.strictObject({ ast_json: z.string() }).parse(
      this.db.prepare("SELECT ast_json FROM revisions WHERE id = ?").get(revisionId),
    );
    const ast = assertValidAst(JSON.parse(row.ast_json) as unknown);
    const ids = new Set<string>();
    if (ast.kind === "feishu_doc") {
      for (const section of ast.sections) {
        ids.add(section.id);
        for (const block of section.blocks) ids.add(block.id);
      }
    } else {
      for (const slide of ast.slides) {
        ids.add(slide.id);
        for (const block of slide.blocks) ids.add(block.id);
      }
    }
    return ids;
  }
}
