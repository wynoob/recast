import type { Block, DeckAst, Slide } from "@dmall/contracts";
import {
  DeckDraftSchema,
  TemplateInstanceSchema,
  type DeckDraft,
  type LayoutDefinition,
  type LayoutId,
  type SlotTrace,
  type TemplateInstance,
  type TemplatePackage,
  type ValidationIssue,
} from "@dmall/contracts";
import { getRegisteredLayout } from "./catalog.js";
import { stableUuid } from "./ids.js";

export type LayoutChangeResult =
  | {
      ok: true;
      draft: DeckDraft;
      movedToUnplaced: string[];
      keptBlockIds: string[];
      warnings: string[];
    }
  | {
      ok: false;
      issues: ValidationIssue[];
      warnings: string[];
    };

export type PlaceBlockResult =
  | {
      ok: true;
      draft: DeckDraft;
      warnings: string[];
    }
  | {
      ok: false;
      issues: ValidationIssue[];
      warnings: string[];
    };

export type ExportReadinessResult =
  | {
      ok: true;
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

function blockTextLength(block: Block): number {
  switch (block.type) {
    case "heading":
      return block.text.length;
    case "paragraph":
    case "callout":
      return block.inlines.reduce((total, inline) => total + inline.text.length, 0);
    case "list":
      return Math.max(
        0,
        ...block.items.map((item) =>
          item.reduce((total, inline) => total + inline.text.length, 0),
        ),
      );
    case "table":
      return Math.max(
        0,
        ...block.columns.map((cell) => cell.length),
        ...block.rows.flatMap((row) =>
          row.map((cell) =>
            cell.reduce((total, inline) => total + inline.text.length, 0),
          ),
        ),
      );
    case "image":
    case "video":
    case "divider":
    case "readonly_source_block":
      return 0;
  }
}

function layoutFor(
  templatePackage: TemplatePackage,
  layoutId: LayoutId,
): LayoutDefinition | null {
  return templatePackage.layouts.find((layout) => layout.id === layoutId) ?? null;
}

export function validateLayoutTitle(input: {
  title: string;
  layout: LayoutDefinition;
  path: string;
}): ValidationIssue[] {
  return input.title.length > input.layout.titleMaxCharacters
    ? [issue(
        "TITLE_CAPACITY_EXCEEDED",
        input.path,
        `标题 ${input.title.length} 字，超过 ${input.layout.titleMaxCharacters} 字`,
      )]
    : [];
}

function blockFitsLayoutSlot(
  block: Block,
  layoutSlotId: string,
  layout: LayoutDefinition,
): { ok: true } | { ok: false; reason: string } {
  const layoutSlot = layout.slots.find((slot) => slot.id === layoutSlotId);
  if (layoutSlot === undefined) {
    return { ok: false, reason: `版式 ${layout.id} 不存在槽位 ${layoutSlotId}` };
  }
  if (!layoutSlot.blockTypes.some((type) => type === block.type)) {
    return {
      ok: false,
      reason: `槽位 ${layoutSlotId} 不允许块类型 ${block.type}`,
    };
  }
  if (
    layoutSlot.maxCharacters !== undefined &&
    blockTextLength(block) > layoutSlot.maxCharacters
  ) {
    return {
      ok: false,
      reason: `块 ${block.id} 文本超过槽位 ${layoutSlotId} 容量`,
    };
  }
  if (
    block.type === "list" &&
    layoutSlot.maxItems !== undefined &&
    block.items.length > layoutSlot.maxItems
  ) {
    return {
      ok: false,
      reason: `块 ${block.id} 条目超过槽位 ${layoutSlotId} 容量`,
    };
  }
  if (
    block.type === "table" &&
    layoutSlot.maxRows !== undefined &&
    block.rows.length > layoutSlot.maxRows
  ) {
    return {
      ok: false,
      reason: `块 ${block.id} 行数超过槽位 ${layoutSlotId} 容量`,
    };
  }
  return { ok: true };
}

function unplacedCopy(block: Block): Block {
  const copy = structuredClone(block);
  return { ...copy, slotId: null };
}

export function instanceToDeckDraft(
  instance: TemplateInstance,
  unplacedOwners: Record<string, string> = {},
): DeckDraft {
  const parsed = TemplateInstanceSchema.parse(instance);
  if (parsed.ast.kind !== "html_deck") {
    throw new Error("只有演示实例可以转换为演示草稿");
  }
  const ids = new Set(parsed.ast.slides.flatMap(slide => [slide.id, ...slide.blocks.map(block => block.id)]));
  const additions = new Map<string, Block[]>();
  for (const block of parsed.unplacedBlocks) {
    const traces = parsed.slotTrace.filter(
      (trace): trace is Extract<SlotTrace, { status: "placed" }> =>
        trace.status === "placed" && trace.blockId === block.id,
    );
    const explicitOwner = unplacedOwners[block.id];
    const trace = traces.length === 1 ? traces[0] : undefined;
    if (explicitOwner === undefined && traces.length > 1) {
      throw new Error(`UNPLACED_OWNER_REQUIRED: 块 ${block.id} 有多条放置轨迹`);
    }
    const owner = explicitOwner ?? (trace === undefined ? undefined : trace.containerNodeId);
    if (owner === undefined || !parsed.ast.slides.some(slide => slide.id === owner)) {
      throw new Error(`UNPLACED_OWNER_REQUIRED: 块 ${block.id} 需要现存演示页归属`);
    }
    if (ids.has(block.id)) throw new Error(`DUPLICATE_NODE_ID: ${block.id}`);
    ids.add(block.id);
    const list = additions.get(owner) ?? [];
    list.push(unplacedCopy(block));
    additions.set(owner, list);
  }
  const slides = parsed.ast.slides.map((slide) => ({
    ...slide,
    blocks: [...slide.blocks, ...(additions.get(slide.id) ?? [])],
  }));
  return DeckDraftSchema.parse({
    schemaVersion: 1,
    templateSnapshot: structuredClone(parsed.templateSnapshot),
    ast: { ...parsed.ast, slides },
  });
}

export function changeDeckSlideLayout(input: {
  draft: DeckDraft;
  slideId: string;
  layoutId: LayoutId;
}): LayoutChangeResult {
  const parsedDraft = DeckDraftSchema.safeParse(input.draft);
  if (!parsedDraft.success) {
    return {
      ok: false,
      issues: [
        issue(
          "DRAFT_SCHEMA_INVALID",
          "draft",
          parsedDraft.error.issues[0]?.message ?? "演示草稿结构无效",
        ),
      ],
      warnings: [],
    };
  }
  const draft = parsedDraft.data;
  if (draft.ast.kind !== "html_deck") {
    return {
      ok: false,
      issues: [issue("DRAFT_KIND_MISMATCH", "draft.ast.kind", "草稿不是演示 AST")],
      warnings: [],
    };
  }
  const layout = layoutFor(draft.templateSnapshot, input.layoutId);
  if (layout === null) {
    return {
      ok: false,
      issues: [
        issue(
          "LAYOUT_NOT_REGISTERED",
          "layoutId",
          `模板包未注册版式 ${input.layoutId}`,
        ),
      ],
      warnings: [],
    };
  }
  const registered = getRegisteredLayout(input.layoutId);
  const slideIndex = draft.ast.slides.findIndex((slide) => slide.id === input.slideId);
  if (slideIndex < 0) {
    return {
      ok: false,
      issues: [issue("SLIDE_NOT_FOUND", "slideId", "演示页不存在")],
      warnings: [],
    };
  }
  const slide = draft.ast.slides[slideIndex];
  if (slide === undefined) {
    return {
      ok: false,
      issues: [issue("SLIDE_NOT_FOUND", "slideId", "演示页不存在")],
      warnings: [],
    };
  }

  const movedToUnplaced: string[] = [];
  const keptBlockIds: string[] = [];
  const warnings: string[] = [];
  const kept: Block[] = [];
  const slotCounts = new Map<string, number>();
  for (const block of slide.blocks) {
    if (block.slotId === null || block.slotId === undefined) {
      kept.push(block);
      continue;
    }
    const fits = blockFitsLayoutSlot(block, block.slotId, layout);
    const layoutSlot = layout.slots.find((item) => item.id === block.slotId);
    const maxItems = layoutSlot?.maxItems ?? 1;
    const used = slotCounts.get(block.slotId) ?? 0;
    if (!fits.ok || used >= maxItems) {
      movedToUnplaced.push(block.id);
      warnings.push(
        !fits.ok
          ? `块 ${block.id} 未映射到新版式：${fits.reason}`
          : `块 ${block.id} 超过新槽位条目容量，保留在未放置列表`,
      );
      kept.push(unplacedCopy(block));
      continue;
    }
    slotCounts.set(block.slotId, used + 1);
    kept.push(block);
    keptBlockIds.push(block.id);
  }

  const nextSlide: Slide = {
    ...slide,
    layout: registered.id,
    blocks: kept,
  };
  const slides = draft.ast.slides.map((item, index) =>
    index === slideIndex ? nextSlide : item,
  );
  const nextAst: DeckAst = { ...draft.ast, slides };
  const nextDraft = DeckDraftSchema.parse({
    ...draft,
    ast: nextAst,
  });
  return {
    ok: true,
    draft: nextDraft,
    movedToUnplaced,
    keptBlockIds,
    warnings,
  };
}

export function placeUnplacedBlock(input: {
  draft: DeckDraft;
  slideId: string;
  blockId: string;
  layoutSlotId: string;
  index?: number;
}): PlaceBlockResult {
  const parsedDraft = DeckDraftSchema.safeParse(input.draft);
  if (!parsedDraft.success) {
    return {
      ok: false,
      issues: [
        issue(
          "DRAFT_SCHEMA_INVALID",
          "draft",
          parsedDraft.error.issues[0]?.message ?? "演示草稿结构无效",
        ),
      ],
      warnings: [],
    };
  }
  const draft = parsedDraft.data;
  if (draft.ast.kind !== "html_deck") {
    return {
      ok: false,
      issues: [issue("DRAFT_KIND_MISMATCH", "draft.ast.kind", "草稿不是演示 AST")],
      warnings: [],
    };
  }
  const slideIndex = draft.ast.slides.findIndex((slide) => slide.id === input.slideId);
  const slide = draft.ast.slides[slideIndex];
  if (slideIndex < 0 || slide === undefined) {
    return {
      ok: false,
      issues: [issue("SLIDE_NOT_FOUND", "slideId", "演示页不存在")],
      warnings: [],
    };
  }
  const layout = layoutFor(draft.templateSnapshot, slide.layout);
  if (layout === null) {
    return {
      ok: false,
      issues: [
        issue(
          "LAYOUT_NOT_REGISTERED",
          "slide.layout",
          `模板包未注册版式 ${slide.layout}`,
        ),
      ],
      warnings: [],
    };
  }
  const block = slide.blocks.find(
    (item) => item.id === input.blockId && (item.slotId === null || item.slotId === undefined),
  );
  if (block === undefined) {
    return {
      ok: false,
      issues: [issue("BLOCK_NOT_UNPLACED", "blockId", "未放置块不存在")],
      warnings: [],
    };
  }
  const fits = blockFitsLayoutSlot(block, input.layoutSlotId, layout);
  if (!fits.ok) {
    return {
      ok: false,
      issues: [issue("SLOT_INCOMPATIBLE", "layoutSlotId", fits.reason)],
      warnings: [],
    };
  }
  const used = slide.blocks.filter(
    (item) => item.slotId === input.layoutSlotId,
  ).length;
  const layoutSlot = layout.slots.find((item) => item.id === input.layoutSlotId);
  const maxItems = layoutSlot?.maxItems ?? 1;
  if (used >= maxItems) {
    return {
      ok: false,
      issues: [
        issue("SLOT_CAPACITY_EXCEEDED", "layoutSlotId", "目标槽位已满"),
      ],
      warnings: [],
    };
  }
  const placedBlock: Block = { ...structuredClone(block), slotId: input.layoutSlotId };
  const insertionIndex =
    input.index === undefined
      ? slide.blocks.length
      : Math.max(0, Math.min(input.index, slide.blocks.length));
  const blocks = slide.blocks.filter((item) => item.id !== input.blockId);
  blocks.splice(insertionIndex, 0, placedBlock);
  const nextSlides = draft.ast.slides.map((item, index) =>
    index === slideIndex ? { ...slide, blocks } : item,
  );
  return {
    ok: true,
    draft: DeckDraftSchema.parse({
      ...draft,
      ast: { ...draft.ast, slides: nextSlides },
    }),
    warnings: [],
  };
}

export function collectUnplacedBlocks(draft: DeckDraft): Block[] {
  const parsed = DeckDraftSchema.parse(draft);
  if (parsed.ast.kind !== "html_deck") return [];
  return parsed.ast.slides.flatMap((slide) =>
    slide.blocks.filter((block) => block.slotId === null || block.slotId === undefined),
  );
}

export function validateExportReadiness(input: {
  instance?: TemplateInstance;
  draft?: DeckDraft;
}): ExportReadinessResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  if (input.instance !== undefined && input.draft !== undefined) {
    return {
      ok: false,
      issues: [
        issue(
          "EXPORT_INPUT_AMBIGUOUS",
          "input",
          "导出检查不能同时使用 instance 与 draft",
        ),
      ],
      warnings,
    };
  }
  let packageValue: TemplatePackage;
  let ast: DeckAst | TemplateInstance["ast"];
  if (input.instance !== undefined) {
    const parsedInstance = TemplateInstanceSchema.safeParse(input.instance);
    if (!parsedInstance.success) {
      return {
        ok: false,
        issues: [
          issue(
            "INSTANCE_SCHEMA_INVALID",
            "instance",
            parsedInstance.error.issues[0]?.message ?? "实例结构无效",
          ),
        ],
        warnings,
      };
    }
    packageValue = parsedInstance.data.templateSnapshot;
    ast = parsedInstance.data.ast;
    for (const block of parsedInstance.data.unplacedBlocks) {
      issues.push(
        issue(
          "UNPLACED_BLOCK",
          "instance.unplacedBlocks",
          `未放置块 ${block.id} 阻止导出`,
        ),
      );
    }
  } else if (input.draft !== undefined) {
    const parsedDraft = DeckDraftSchema.safeParse(input.draft);
    if (!parsedDraft.success) {
      return {
        ok: false,
        issues: [
          issue(
            "DRAFT_SCHEMA_INVALID",
            "draft",
            parsedDraft.error.issues[0]?.message ?? "草稿结构无效",
          ),
        ],
        warnings,
      };
    }
    packageValue = parsedDraft.data.templateSnapshot;
    ast = parsedDraft.data.ast;
    if (parsedDraft.data.ast.kind !== "html_deck") {
      return {
        ok: false,
        issues: [issue("DRAFT_KIND_MISMATCH", "draft.ast.kind", "草稿不是演示 AST")],
        warnings,
      };
    }
    for (const [slideIndex, slide] of parsedDraft.data.ast.slides.entries()) {
      for (const block of slide.blocks) {
        if (block.slotId !== null && block.slotId !== undefined) continue;
        issues.push(
          issue(
            "UNPLACED_BLOCK",
            `draft.ast.slides[${slideIndex}].blocks`,
            `未放置块 ${block.id} 阻止导出`,
          ),
        );
      }
    }
  } else {
    return {
      ok: false,
      issues: [
        issue(
          "EXPORT_INPUT_MISSING",
          "input",
          "导出检查需要 instance 或 draft",
        ),
      ],
      warnings,
    };
  }

  if (ast.kind === "html_deck") {
    for (const [slideIndex, slide] of ast.slides.entries()) {
      const layout = layoutFor(packageValue, slide.layout);
      if (layout === null) {
        issues.push(
          issue(
            "LAYOUT_NOT_REGISTERED",
            `ast.slides[${slideIndex}].layout`,
            `版式未注册 ${slide.layout}`,
          ),
        );
        continue;
      }
      issues.push(...validateLayoutTitle({
        title: slide.title,
        layout,
        path: `ast.slides[${slideIndex}].title`,
      }));
      const counts = new Map<string, number>();
      for (const block of slide.blocks) {
        if (block.slotId === null || block.slotId === undefined) {
          issues.push(
            issue(
              "UNPLACED_BLOCK",
              `ast.slides[${slideIndex}].blocks`,
              `块 ${block.id} 未放置`,
            ),
          );
          continue;
        }
        const fits = blockFitsLayoutSlot(block, block.slotId, layout);
        if (!fits.ok) {
          issues.push(
            issue(
              "LAYOUT_SLOT_INVALID",
              `ast.slides[${slideIndex}].blocks`,
              fits.reason,
            ),
          );
        }
        const used = counts.get(block.slotId) ?? 0;
        const layoutSlot = layout.slots.find((slot) => slot.id === block.slotId);
        const maxItems = layoutSlot?.maxItems ?? 1;
        if (used >= maxItems) {
          issues.push(
            issue(
              "SLOT_CAPACITY_EXCEEDED",
              `ast.slides[${slideIndex}].blocks`,
              `槽位 ${block.slotId} 超过条目容量`,
            ),
          );
        }
        counts.set(block.slotId, used + 1);
      }
    }
  }

  return issues.length === 0
    ? { ok: true, warnings }
    : { ok: false, issues, warnings };
}

export function newDraftSlideId(contentId: string, index: number): string {
  return stableUuid(`new-draft-slide:${contentId}:${index}`);
}
