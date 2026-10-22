import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AuthoringOperationSchema,
  BriefSchema,
  MaterialRefSchema,
  type AuthoringOperation,
  type CandidateView,
  type FixedEvidence,
} from "@dmall/contracts";
import { instantiateTemplate } from "@dmall/templates";
import { ApiError } from "../errors.js";
import { CandidateService } from "./candidates.js";
import { GenerationInputService } from "./generation-inputs.js";
import { MessageService } from "./messages.js";
import { PlanService } from "./plans.js";
import type { RevisionRepository } from "./revisions.js";

export class LocalGenerationService {
  private readonly plans: PlanService;
  private readonly messages: MessageService;

  constructor(
    private readonly db: Database.Database,
    private readonly revisions: RevisionRepository,
    private readonly inputs: GenerationInputService,
    private readonly candidates: CandidateService,
    plans?: PlanService,
    messages?: MessageService,
  ) {
    this.plans = plans ?? new PlanService(db);
    this.messages = messages ?? new MessageService(db);
  }

  generate(contentId: string, renditionId: string, inputId: string): {
    candidate: CandidateView;
    warnings: string[];
  } {
    return this.db.transaction(() => {
      const input = this.inputs.require(inputId);
      if (input.contentId !== contentId || input.renditionId !== renditionId) {
        throw new ApiError({ statusCode: 422, code: "TARGET_SCOPE_INVALID", message: "生成输入与目标内容不匹配" });
      }
      const rendition = z.strictObject({
        current_revision_id: z.uuid(),
        root_node_id: z.uuid(),
      }).parse(this.db.prepare(
        "SELECT current_revision_id, root_node_id FROM renditions WHERE id = ?",
      ).get(renditionId));
      if (rendition.current_revision_id !== input.baseRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "本地结构生成必须从当前固定基线开始",
          details: { currentRevisionId: rendition.current_revision_id },
        });
      }
      const base = this.revisions.viewById(input.baseRevisionId);
      const empty = base.ast.kind === "feishu_doc"
        ? base.ast.sections.length === 0
        : base.ast.slides.length === 0;
      if (!empty) {
        throw new ApiError({
          statusCode: 409,
          code: "VALIDATION_ERROR",
          message: "本地模板草稿只用于首次空稿；已有内容请使用局部候选或手工编辑",
        });
      }
      const confirmation = this.plans.getConfirmation(input.confirmationId);
      const brief = BriefSchema.parse(confirmation.brief);
      const materials = input.evidence.flatMap(materialFromEvidence);
      const facts = input.evidence.flatMap((item) =>
        item.kind === "fact"
          ? [{
              schemaVersion: 1 as const,
              factVersionId: item.entity.factVersionId,
              merchantId: item.entity.merchantId,
              statement: item.entity.statement,
            }]
          : []);
      const instantiated = instantiateTemplate({
        templatePackage: input.templatePackage,
        brief,
        targetKind: input.targetKind,
        materials,
        facts,
      });
      if (!instantiated.ok) {
        throw new ApiError({
          statusCode: 422,
          code: "TEMPLATE_INVALID",
          message: instantiated.issues[0]?.message ?? "模板无法实例化",
          details: { issues: instantiated.issues },
        });
      }
      const ast = structuredClone(instantiated.instance.ast);
      if (instantiated.instance.unplacedBlocks.length > 0) {
        const missing: string[] = [];
        for (const block of instantiated.instance.unplacedBlocks) {
          const ownerId = input.unplacedOwnerMap[block.id];
          if (ownerId === undefined) {
            missing.push(block.id);
            continue;
          }
          if (ast.kind === "html_deck") {
            const slide = ast.slides.find((item) => item.id === ownerId);
            if (slide === undefined) missing.push(block.id);
            else slide.blocks.push(structuredClone(block));
          } else {
            const section = ast.sections.find((item) => item.id === ownerId);
            if (section === undefined) missing.push(block.id);
            else section.blocks.push(structuredClone(block));
          }
        }
        if (missing.length > 0) {
          throw new ApiError({
            statusCode: 409,
            code: "UNPLACED_OWNER_REQUIRED",
            message: "模板有未放置块，必须为每个块指定明确容器；原草稿保留，未生成候选",
            details: {
              blockIds: missing,
              originalAst: instantiated.instance.ast,
            },
          });
        }
      }
      const operations: AuthoringOperation[] = [];
      if (ast.kind === "feishu_doc") {
        for (const section of ast.sections) {
          operations.push(AuthoringOperationSchema.parse({
            op: "insertNode",
            parentId: rendition.root_node_id,
            afterId: null,
            node: section,
          }));
        }
      } else {
        for (const slide of ast.slides) {
          operations.push(AuthoringOperationSchema.parse({
            op: "insertNode",
            parentId: rendition.root_node_id,
            afterId: null,
            node: slide,
          }));
        }
      }
      const candidate = this.candidates.create(renditionId, {
        schemaVersion: 1,
        inputId,
        expectedRevisionId: rendition.current_revision_id,
        operations,
        claims: [],
        modelRunId: null,
      });
      this.messages.createAssistant({
        contentId,
        renditionId,
        mode: "revise",
        text: `已按固定模板生成本地结构草稿，可逐项审核。这不是在线模型结果。${instantiated.warnings.length > 0 ? ` ${instantiated.warnings.join("；")}` : ""}`,
        candidateId: candidate.id,
        targetNodeIds: input.targetNodeIds,
      });
      return { candidate, warnings: instantiated.warnings };
    }).immediate();
  }
}

function materialFromEvidence(evidence: FixedEvidence): import("@dmall/contracts").MaterialRef[] {
  if (evidence.kind !== "media" || evidence.occurrence === null) return [];
  const locator = evidence.occurrence.locator;
  if (evidence.mediaKind === "video") {
    if (evidence.poster === null) return [];
    return [MaterialRefSchema.parse({
      schemaVersion: 1,
      materialId: evidence.evidenceId,
      kind: "video",
      assetVersionId: evidence.assetVersionId,
      segmentId: evidence.segment?.id ?? null,
      posterDerivativeId: evidence.poster.id,
      sourceVersionId: evidence.occurrence.sourceVersionId,
      locator,
      caption: "",
    })];
  }
  if (evidence.mediaKind === "image" || evidence.mediaKind === "gif") {
    return [MaterialRefSchema.parse({
      schemaVersion: 1,
      materialId: evidence.evidenceId,
      kind: "image",
      assetVersionId: evidence.assetVersionId,
      derivativeId: evidence.derivative?.id ?? null,
      occurrenceId: evidence.occurrence.requestedOccurrenceId,
      sourceVersionId: evidence.occurrence.sourceVersionId,
      locator,
      caption: "",
      alt: "选中素材",
      fit: "contain",
    })];
  }
  return [];
}
