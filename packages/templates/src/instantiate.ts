import { validateAst } from "@dmall/domain";
import { buildContainerSlots, type SlotContext } from "./slot-content.js";
import {
  BriefSchema,
  FactRefSchema,
  InstantiateTemplateInputSchema,
  MaterialRefSchema,
  SlotBindingSchema,
  TemplateInstanceSchema,
  TemplatePackageSchema,
  type Brief,
  type SlotBinding,
  type SlotTrace,
  type TemplateInstance,
  type TemplatePackage,
  type TemplateSlot,
  type ValidationIssue,
} from "@dmall/contracts";
import { buildBuiltinTemplatePackage } from "./catalog.js";
import { stableUuid } from "./ids.js";
import { validateLayoutTitle } from "./layouts.js";

export type InstantiationResult =
  | {
      ok: true;
      instance: TemplateInstance;
      warnings: string[];
    }
  | {
      ok: false;
      issues: ValidationIssue[];
      warnings: string[];
    };

function issue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function zodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }, prefix: string): ValidationIssue[] {
  return error.issues.map((item) =>
    issue(
      "SCHEMA_INVALID",
      `${prefix}.${item.path.map(String).join(".")}`,
      item.message,
    ),
  );
}

function buildDocAst(
  templatePackage: TemplatePackage,
  brief: Brief,
  context: SlotContext,
): {
  ast: unknown;
  trace: SlotTrace[];
  issues: ValidationIssue[];
  warnings: string[];
} {
  const outline = brief.mustKeepOutline ? brief.userOutline : [];
  const sections: unknown[] = [];
  const trace: SlotTrace[] = [];
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];

  for (const [index, templateSection] of templatePackage.narrative.doc.sections.entries()) {
    const outlineItem = outline[index];
    const sectionId =
      outlineItem?.id ??
      stableUuid(`doc-section:${brief.contentId}:${templatePackage.manifest.templateVersionId}:${templateSection.id}`);
    const title = outlineItem?.title ?? templateSection.title;
    const built = buildContainerSlots(context, templateSection.id, sectionId, "doc", `doc.sections[${index}]`);
    issues.push(...built.issues);
    warnings.push(...built.warnings);
    trace.push(...built.trace);
    sections.push({
      id: sectionId,
      title,
      blocks: built.blocks,
      locks: [],
    });
  }

  for (const outlineItem of outline.slice(templatePackage.narrative.doc.sections.length)) {
    sections.push({
      id: outlineItem.id,
      title: outlineItem.title,
      blocks: [],
      locks: [],
    });
    warnings.push(`用户大纲章节 ${outlineItem.title} 没有内置槽位，保留为待补章节`);
  }

  return {
    ast: {
      schemaVersion: 1,
      kind: "feishu_doc",
      title: brief.goal,
      locks: [],
      sections,
      speakerNotes: {},
    },
    trace,
    issues,
    warnings,
  };
}

function buildDeckAst(
  templatePackage: TemplatePackage,
  brief: Brief,
  context: SlotContext,
): {
  ast: unknown;
  trace: SlotTrace[];
  issues: ValidationIssue[];
  warnings: string[];
} {
  const outline = brief.mustKeepOutline ? brief.userOutline : [];
  const slides: unknown[] = [];
  const trace: SlotTrace[] = [];
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];

  for (const [index, templateSlide] of templatePackage.narrative.deck.slides.entries()) {
    const outlineItem = outline[index];
    const title = outlineItem?.title ?? templateSlide.title;
    const layout = templatePackage.layouts.find((item) => item.id === templateSlide.layout);
    if (layout === undefined) {
      issues.push(
        issue(
          "LAYOUT_NOT_REGISTERED",
          `deck.slides[${index}].layout`,
          `版式未注册: ${templateSlide.layout}`,
        ),
      );
      continue;
    }
    issues.push(...validateLayoutTitle({
      title,
      layout,
      path: `deck.slides[${index}].title`,
    }));
    const slideId =
      index < outline.length && outlineItem !== undefined
        ? stableUuid(`deck-slide-outline:${brief.contentId}:${outlineItem.id}`)
        : stableUuid(`deck-slide:${brief.contentId}:${templatePackage.manifest.templateVersionId}:${templateSlide.id}`);
    const built = buildContainerSlots(context, templateSlide.id, slideId, "deck", `deck.slides[${index}]`);
    issues.push(...built.issues);
    warnings.push(...built.warnings);
    trace.push(...built.trace);
    slides.push({
      id: slideId,
      layout: templateSlide.layout,
      title,
      blocks: built.blocks,
      speakerNotes: "",
      locks: [],
    });
  }

  if (outline.length > templatePackage.narrative.deck.slides.length) {
    issues.push(
      issue(
        "OUTLINE_EXCEEDS_DECK_CAPACITY",
        "brief.userOutline",
        `用户大纲 ${outline.length} 项超过模板演示页 ${templatePackage.narrative.deck.slides.length} 页`,
      ),
    );
  }

  return {
    ast: {
      schemaVersion: 1,
      kind: "html_deck",
      title: brief.goal,
      locks: [],
      canvas: { width: 1600, height: 900 },
      slides,
    },
    trace,
    issues,
    warnings,
  };
}

export function instantiateTemplate(input: unknown): InstantiationResult {
  const parsed = InstantiateTemplateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: zodIssues(parsed.error, "input"),
      warnings: [],
    };
  }
  const data = parsed.data;
  if (data.templatePackage.manifest.status === "archived") {
    return {
      ok: false,
      issues: [
        issue(
          "TEMPLATE_ARCHIVED",
          "templatePackage.manifest.status",
          "归档模板不能实例化",
        ),
      ],
      warnings: [],
    };
  }
  if (data.templatePackage.manifest.kind !== data.targetKind) {
    return {
      ok: false,
      issues: [
        issue(
          "TARGET_KIND_MISMATCH",
          "targetKind",
          "模板输出类型与显式 targetKind 不一致",
        ),
      ],
      warnings: [],
    };
  }

  const slotBindings = data.slotBindings ?? {};
  const slotIds = new Set(data.templatePackage.slots.map(slot => slot.id));
  const unknownBindings = Object.keys(slotBindings).filter(id => !slotIds.has(id));
  if (unknownBindings.length > 0) {
    return { ok: false, issues: unknownBindings.map(id => issue("UNKNOWN_SLOT_BINDING", `slotBindings.${id}`, `未知槽位绑定: ${id}`)), warnings: [] };
  }
  const slotsByContainer = new Map<string, TemplateSlot[]>();
  for (const slot of data.templatePackage.slots) {
    const slots = slotsByContainer.get(slot.containerId) ?? [];
    slots.push(slot);
    slotsByContainer.set(slot.containerId, slots);
  }
  for (const slots of slotsByContainer.values()) slots.sort((a, b) => a.order - b.order);
  const context: SlotContext = { brief: data.brief, materials: data.materials, facts: data.facts, bindings: slotBindings, slotsByContainer };

  const built =
    data.targetKind === "feishu_doc"
      ? buildDocAst(
          data.templatePackage,
          data.brief,
          context,
        )
      : buildDeckAst(
          data.templatePackage,
          data.brief,
          context,
        );

  if (built.issues.length > 0) {
    return { ok: false, issues: built.issues, warnings: built.warnings };
  }
  const ast = validateAst(built.ast);
  if (!ast.ok) {
    return {
      ok: false,
      issues: ast.violations.map(v => issue(v.code, v.nodeId === undefined ? "ast" : `ast.${v.nodeId}`, v.message)),
      warnings: built.warnings,
    };
  }

  const instance = TemplateInstanceSchema.safeParse({
    schemaVersion: 1,
    instanceId: stableUuid(
      `instance:${data.brief.contentId}:${data.templatePackage.manifest.templateVersionId}`,
    ),
    contentId: data.brief.contentId,
    templateSnapshot: structuredClone(data.templatePackage),
    ast: ast.ast,
    unplacedBlocks: [],
    slotTrace: built.trace,
    warnings: built.warnings,
  });
  if (!instance.success) {
    return {
      ok: false,
      issues: zodIssues(instance.error, "instance"),
      warnings: built.warnings,
    };
  }
  return { ok: true, instance: instance.data, warnings: built.warnings };
}

export function instantiateBuiltinTemplate(
  narrativeId: TemplatePackage["manifest"]["narrativeId"],
  kind: "feishu_doc" | "html_deck",
  brief: unknown,
  materials: unknown[],
  facts: unknown[],
  slotBindings?: Record<string, unknown>,
): InstantiationResult {
  const parsedBrief = BriefSchema.safeParse(brief);
  const parsedMaterials = materials.map((item) => MaterialRefSchema.safeParse(item));
  const parsedFacts = facts.map((item) => FactRefSchema.safeParse(item));
  const parsedBindings = Object.fromEntries(
    Object.entries(slotBindings ?? {}).map(([key, value]) => [
      key,
      SlotBindingSchema.safeParse(value),
    ]),
  );
  const issues: ValidationIssue[] = [];
  if (!parsedBrief.success) issues.push(...zodIssues(parsedBrief.error, "brief"));
  for (const [index, parsed] of parsedMaterials.entries()) {
    if (!parsed.success) issues.push(...zodIssues(parsed.error, `materials[${index}]`));
  }
  for (const [index, parsed] of parsedFacts.entries()) {
    if (!parsed.success) issues.push(...zodIssues(parsed.error, `facts[${index}]`));
  }
  for (const [key, parsed] of Object.entries(parsedBindings)) {
    if (!parsed.success) issues.push(...zodIssues(parsed.error, `slotBindings.${key}`));
  }
  if (issues.length > 0 || !parsedBrief.success) {
    return { ok: false, issues, warnings: [] };
  }
  const packages = buildBuiltinTemplatePackage(narrativeId, kind);
  return instantiateTemplate({
    templatePackage: packages,
    brief: parsedBrief.data,
    targetKind: kind,
    materials: parsedMaterials
      .filter((item) => item.success)
      .map((item) => item.data),
    facts: parsedFacts
      .filter((item) => item.success)
      .map((item) => item.data),
    slotBindings: Object.fromEntries(
      Object.entries(parsedBindings)
        .filter((entry): entry is [string, { success: true; data: SlotBinding }] => entry[1].success)
        .map(([key, parsed]) => [key, parsed.data]),
    ),
  });
}

export function reviseTemplatePackage(input: {
  templatePackage: TemplatePackage;
  templateVersionId: string;
  changeSummary: string;
  now?: string;
}): TemplatePackage {
  const now = input.now ?? new Date().toISOString();
  const draft = {
    ...input.templatePackage,
    manifest: {
      ...input.templatePackage.manifest,
      templateVersionId: input.templateVersionId,
      version: input.templatePackage.manifest.version + 1,
      status: "draft" as const,
      previousVersionId: input.templatePackage.manifest.templateVersionId,
      changeSummary: input.changeSummary,
      updatedAt: now,
    },
  };
  return TemplatePackageSchema.parse(draft);
}
