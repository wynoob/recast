import { z } from "zod";
import {
  AstSchema,
  BlockSchema,
  ContentKindSchema,
  LocatorSchema,
} from "./ast.js";
import { BriefSchema } from "./api.js";
import {
  AssetVersionIdSchema,
  HashSchema,
  SchemaVersionSchema,
  SourceVersionIdSchema,
  TemplateVersionIdSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";

const SlugSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "标识必须使用小写短横线格式");
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色必须为六位十六进制");
const FontTokenSchema = z.enum(["ui-sans", "ui-serif", "ui-mono"]);
const RendererVersionSchema = z.enum(["docx-1", "deck-1"]);

export const NarrativeIdSchema = z.enum([
  "product-intro",
  "executive-progress",
  "phase-review",
  "merchant-solution",
  "internal-sharing",
  "training",
]);
export type NarrativeId = z.infer<typeof NarrativeIdSchema>;

export const LayoutIdSchema = z.enum([
  "cover",
  "section",
  "title-body-media",
  "two-column",
  "metric-evidence",
  "steps",
  "table",
  "closing",
]);
export type LayoutId = z.infer<typeof LayoutIdSchema>;

export const TemplateSlotBlockTypeSchema = z.enum([
  "paragraph",
  "list",
  "image",
  "video",
  "table",
  "callout",
  "divider",
]);
export type TemplateSlotBlockType = z.infer<typeof TemplateSlotBlockTypeSchema>;

export const ThemeSchema = z.strictObject({
  id: z.literal("violet-glass"),
  name: z.string().min(1),
  palette: z.strictObject({
    background: HexColorSchema,
    backgroundAlt: HexColorSchema,
    surface: HexColorSchema,
    surfaceStrong: HexColorSchema,
    text: HexColorSchema,
    muted: HexColorSchema,
    accent: HexColorSchema,
    accentStrong: HexColorSchema,
    accentText: HexColorSchema,
    border: HexColorSchema,
    success: HexColorSchema,
    warning: HexColorSchema,
  }),
  typography: z.strictObject({
    heading: FontTokenSchema,
    body: FontTokenSchema,
    mono: FontTokenSchema,
  }),
  radius: z.strictObject({
    panel: z.number().int().min(16).max(32),
    card: z.number().int().min(8).max(32),
    control: z.number().int().min(8).max(24),
  }),
  glass: z.strictObject({
    surfaceOpacity: z.number().min(0.4).max(0.95),
    borderOpacity: z.number().min(0.2).max(1),
    blurPx: z.number().int().min(0).max(32),
  }),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const CapabilitiesSchema = z.strictObject({
  editableText: z.boolean(),
  simpleTable: z.boolean(),
  video: z.enum(["none", "poster_only", "playback"]),
  rawHtml: z.literal(false),
  userScript: z.literal(false),
  remoteAssets: z.literal(false),
  remoteFonts: z.literal(false),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const SlotCapacitySchema = z.strictObject({
  maxCharacters: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  maxRows: z.number().int().positive().optional(),
});
export type SlotCapacity = z.infer<typeof SlotCapacitySchema>;

export const SlotDefaultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("list"),
    items: z.array(z.string().min(1)).min(1),
  }),
  z
    .strictObject({
      kind: z.literal("table"),
      columns: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.string())),
    })
    .refine(
      (value) => value.rows.every((row) => row.length === value.columns.length),
      "默认表格每行单元格数必须与列数一致",
    ),
]);
export type SlotDefault = z.infer<typeof SlotDefaultSchema>;

export const SlotSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("brief"),
    field: z.enum(["title", "goal", "tone", "audience", "outline", "durationMinutes"]),
  }),
  z.strictObject({
    kind: z.literal("material"),
    mediaKind: z.enum(["image", "video"]),
  }),
  z.strictObject({ kind: z.literal("fact") }),
  z.strictObject({ kind: z.literal("default"), value: SlotDefaultSchema }),
]);
export type SlotSource = z.infer<typeof SlotSourceSchema>;

export const TemplateSlotSchema = z.strictObject({
  id: SlugSchema,
  containerId: SlugSchema,
  layoutSlotId: SlugSchema.optional(),
  order: z.number().int().nonnegative(),
  label: z.string().min(1),
  blockType: TemplateSlotBlockTypeSchema,
  required: z.boolean(),
  capacity: SlotCapacitySchema,
  source: SlotSourceSchema,
});
export type TemplateSlot = z.infer<typeof TemplateSlotSchema>;

export const NarrativeSectionSchema = z.strictObject({
  id: SlugSchema,
  title: z.string().min(1),
  purpose: z.string().min(1),
  requiredEvidence: z.array(z.string().min(1)),
});
export type NarrativeSection = z.infer<typeof NarrativeSectionSchema>;

export const NarrativeSlideSchema = z.strictObject({
  id: SlugSchema,
  layout: LayoutIdSchema,
  title: z.string().min(1),
  purpose: z.string().min(1),
});
export type NarrativeSlide = z.infer<typeof NarrativeSlideSchema>;

export const NarrativeDefinitionSchema = z.strictObject({
  id: NarrativeIdSchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  doc: z.strictObject({
    sections: z.array(NarrativeSectionSchema).min(1),
  }),
  deck: z.strictObject({
    slides: z.array(NarrativeSlideSchema).min(1),
  }),
});
export type NarrativeDefinition = z.infer<typeof NarrativeDefinitionSchema>;

export const LayoutSlotSchema = z.strictObject({
  id: SlugSchema,
  label: z.string().min(1),
  blockTypes: z.array(TemplateSlotBlockTypeSchema).min(1),
  required: z.boolean(),
  maxCharacters: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  maxRows: z.number().int().positive().optional(),
});
export type LayoutSlot = z.infer<typeof LayoutSlotSchema>;

export const LayoutDefinitionSchema = z.strictObject({
  id: LayoutIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  canvas: z.strictObject({
    width: z.literal(1600),
    height: z.literal(900),
  }),
  titleMaxCharacters: z.number().int().positive(),
  slots: z.array(LayoutSlotSchema),
});
export type LayoutDefinition = z.infer<typeof LayoutDefinitionSchema>;

export const TemplateManifestSchema = z.strictObject({
  id: UuidSchema,
  templateVersionId: UuidSchema,
  name: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["draft", "ready", "archived"]),
  kind: ContentKindSchema,
  narrativeId: NarrativeIdSchema,
  previousVersionId: UuidSchema.nullable(),
  changeSummary: z.string().min(1),
  customerSpecificDefaults: z.literal(false),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

const FORBIDDEN_KEYS = new Set([
  "script",
  "scripts",
  "html",
  "css",
  "styles",
  "stylesheet",
  "javascript",
  "onload",
  "onclick",
  "eval",
]);

const FORBIDDEN_TEXT = [
  /<\s*script\b/i,
  /<\s*style\b/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /expression\s*\(/i,
  /@import\b/i,
  /url\s*\(/i,
  /\beval\s*\(/i,
];

export interface ForbiddenPayloadIssue {
  path: string;
  reason: string;
}

export function findForbiddenTemplatePayload(
  input: unknown,
  path = "$",
): ForbiddenPayloadIssue[] {
  if (typeof input === "string") {
    const reason = FORBIDDEN_TEXT.find((pattern) => pattern.test(input))?.source;
    return reason === undefined ? [] : [{ path, reason: `禁止的模板内容 ${reason}` }];
  }
  if (Array.isArray(input)) {
    return input.flatMap((value, index) =>
      findForbiddenTemplatePayload(value, `${path}[${index}]`),
    );
  }
  if (input !== null && typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) => {
      const issues = FORBIDDEN_KEYS.has(key.toLowerCase())
        ? [{ path: `${path}.${key}`, reason: `禁止的执行字段 ${key}` }]
        : [];
      return issues.concat(findForbiddenTemplatePayload(value, `${path}.${key}`));
    });
  }
  return [];
}

function hasNarrativeContainer(
  narrative: NarrativeDefinition,
  kind: "feishu_doc" | "html_deck",
  id: string,
): boolean {
  if (kind === "feishu_doc") {
    return narrative.doc.sections.some((section) => section.id === id);
  }
  return narrative.deck.slides.some((slide) => slide.id === id);
}

function capacityForLayoutSlot(
  layout: LayoutDefinition,
  slotId: string,
): LayoutSlot | null {
  return layout.slots.find((slot) => slot.id === slotId) ?? null;
}

export const TemplatePackageSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    manifest: TemplateManifestSchema,
    narrative: NarrativeDefinitionSchema,
    layouts: z.array(LayoutDefinitionSchema),
    theme: ThemeSchema,
    capabilities: CapabilitiesSchema,
    slots: z.array(TemplateSlotSchema).min(1),
    rendererVersion: RendererVersionSchema,
  })
  .superRefine((pkg, ctx) => {
    const expectedRenderer = pkg.manifest.kind === "feishu_doc" ? "docx-1" : "deck-1";
    if (pkg.rendererVersion !== expectedRenderer) {
      ctx.addIssue({
        code: "custom",
        path: ["rendererVersion"],
        message: `渲染器版本必须为 ${expectedRenderer}`,
      });
    }
    if (pkg.manifest.narrativeId !== pkg.narrative.id) {
      ctx.addIssue({
        code: "custom",
        path: ["manifest", "narrativeId"],
        message: "manifest.narrativeId 必须与 narrative.id 一致",
      });
    }
    if (pkg.manifest.kind === "feishu_doc" && pkg.layouts.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["layouts"],
        message: "文档模板不应声明演示版式",
      });
    }
    if (pkg.manifest.kind === "html_deck" && pkg.layouts.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["layouts"],
        message: "演示模板必须声明受控版式",
      });
    }

    const uniqueIds = (items: { id: string }[], path: (string | number)[]) => {
      const ids = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: [...path, index, "id"], message: `ID 重复: ${item.id}` });
        ids.add(item.id);
      }
    };
    uniqueIds(pkg.narrative.doc.sections, ["narrative", "doc", "sections"]);
    uniqueIds(pkg.narrative.deck.slides, ["narrative", "deck", "slides"]);
    uniqueIds(pkg.layouts, ["layouts"]);
    pkg.layouts.forEach((layout, index) => uniqueIds(layout.slots, ["layouts", index, "slots"]));
    const slotIds = new Set<string>();
    const orderByContainer = new Map<string, Set<number>>();
    for (const [index, slot] of pkg.slots.entries()) {
      const slotPath = ["slots", index] as const;
      if (slotIds.has(slot.id)) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "id"],
          message: `槽位 ID 重复: ${slot.id}`,
        });
      }
      slotIds.add(slot.id);
      const containerExists = hasNarrativeContainer(
        pkg.narrative,
        pkg.manifest.kind,
        slot.containerId,
      );
      if (!containerExists) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "containerId"],
          message: `槽位容器不存在: ${slot.containerId}`,
        });
        continue;
      }
      const orders = orderByContainer.get(slot.containerId) ?? new Set<number>();
      if (orders.has(slot.order)) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "order"],
          message: `同一容器的槽位顺序重复: ${slot.containerId}/${slot.order}`,
        });
      }
      orders.add(slot.order);
      orderByContainer.set(slot.containerId, orders);

      if (pkg.manifest.kind === "feishu_doc") {
        if (slot.layoutSlotId !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "layoutSlotId"],
            message: "文档槽位不应绑定演示版式槽位",
          });
        }
      } else {
        if (slot.layoutSlotId === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "layoutSlotId"],
            message: "演示槽位必须绑定版式槽位",
          });
          continue;
        }
        const slide = pkg.narrative.deck.slides.find(
          (item) => item.id === slot.containerId,
        );
        if (slide === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "containerId"],
            message: `演示页不存在: ${slot.containerId}`,
          });
          continue;
        }
        const layout = pkg.layouts.find((item) => item.id === slide.layout);
        if (layout === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "layoutSlotId"],
            message: `引用的版式未注册: ${slide.layout}`,
          });
          continue;
        }
        const layoutSlot = capacityForLayoutSlot(layout, slot.layoutSlotId);
        if (layoutSlot === null) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "layoutSlotId"],
            message: `版式 ${layout.id} 不存在槽位 ${slot.layoutSlotId}`,
          });
          continue;
        }
        if (!layoutSlot.blockTypes.some((type) => type === slot.blockType)) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "blockType"],
            message: `版式 ${layout.id}/${layoutSlot.id} 不允许 ${slot.blockType}`,
          });
        }
        if (
          slot.capacity.maxCharacters !== undefined &&
          layoutSlot.maxCharacters !== undefined &&
          slot.capacity.maxCharacters > layoutSlot.maxCharacters
        ) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "capacity", "maxCharacters"],
            message: "槽位字符容量超过版式容量",
          });
        }
      }

      if (
        (slot.blockType === "paragraph" || slot.blockType === "callout") &&
        slot.capacity.maxCharacters === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "capacity", "maxCharacters"],
          message: "文本槽位必须声明字符容量",
        });
      }
      if (slot.blockType === "list" && slot.capacity.maxItems === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "capacity", "maxItems"],
          message: "列表槽位必须声明条目容量",
        });
      }
      if (slot.blockType === "table" && slot.capacity.maxRows === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "capacity", "maxRows"],
          message: "表格槽位必须声明行容量",
        });
      }
      if (
        (slot.blockType === "image" || slot.blockType === "video") &&
        slot.source.kind !== "material"
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "source"],
          message: "媒体槽位只能引用显式素材",
        });
      }
      if (
        slot.source.kind === "material" &&
        slot.source.mediaKind === "image" &&
        slot.blockType !== "image"
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "blockType"],
          message: "图片素材只能绑定图片块",
        });
      }
      if (
        slot.source.kind === "material" &&
        slot.source.mediaKind === "video" &&
        slot.blockType !== "video"
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "blockType"],
          message: "视频素材只能绑定视频块",
        });
      }
      if (slot.source.kind === "default") {
        const expected = defaultKindForBlock(slot.blockType);
        if (expected !== null && slot.source.value.kind !== expected) {
          ctx.addIssue({
            code: "custom",
            path: [...slotPath, "source", "value", "kind"],
            message: `${slot.blockType} 槽位默认值类型必须为 ${expected}`,
          });
        }
      }
      if (
        slot.blockType === "table" &&
        slot.source.kind === "brief"
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...slotPath, "source"],
          message: "表格槽位不能直接从 brief 标量生成",
        });
      }
    }

    if (pkg.manifest.kind === "html_deck") {
      const layoutIds = new Set(pkg.layouts.map((layout) => layout.id));
      for (const [index, slide] of pkg.narrative.deck.slides.entries()) {
        if (!layoutIds.has(slide.layout)) {
          ctx.addIssue({
            code: "custom",
            path: ["narrative", "deck", "slides", index, "layout"],
            message: `叙事页引用的版式未包含在模板包中: ${slide.layout}`,
          });
          continue;
        }
        const layout = pkg.layouts.find((item) => item.id === slide.layout);
        if (layout === undefined) continue;
        for (const layoutSlot of layout.slots) {
          if (!layoutSlot.required) continue;
          const bound = pkg.slots.some(
            (slot) =>
              slot.containerId === slide.id &&
              slot.layoutSlotId === layoutSlot.id,
          );
          if (!bound) {
            ctx.addIssue({
              code: "custom",
              path: ["narrative", "deck", "slides", index, "id"],
              message: `必填版式槽位缺少模板槽位: ${slide.id}/${layoutSlot.id}`,
            });
          }
        }
      }
    }

    for (const issue of findForbiddenTemplatePayload(pkg)) {
      ctx.addIssue({
        code: "custom",
        path: ["$payload"],
        message: `${issue.path}: ${issue.reason}`,
      });
    }
  });
export type TemplatePackage = z.infer<typeof TemplatePackageSchema>;

function defaultKindForBlock(
  blockType: TemplateSlotBlockType,
): SlotDefault["kind"] | null {
  switch (blockType) {
    case "paragraph":
    case "callout":
    case "divider":
      return "text";
    case "list":
      return "list";
    case "table":
      return "table";
    case "image":
    case "video":
      return null;
  }
}

export const ImageMaterialRefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  materialId: UuidSchema,
  kind: z.literal("image"),
  assetVersionId: AssetVersionIdSchema,
  derivativeId: UuidSchema.nullable(),
  occurrenceId: UuidSchema,
  sourceVersionId: SourceVersionIdSchema,
  locator: LocatorSchema,
  caption: z.string(),
  alt: z.string().min(1),
  fit: z.enum(["contain", "cover"]),
});

export const VideoMaterialRefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  materialId: UuidSchema,
  kind: z.literal("video"),
  assetVersionId: AssetVersionIdSchema,
  segmentId: UuidSchema.nullable(),
  posterDerivativeId: UuidSchema,
  sourceVersionId: SourceVersionIdSchema,
  locator: LocatorSchema,
  caption: z.string(),
});

export const MaterialRefSchema = z.discriminatedUnion("kind", [
  ImageMaterialRefSchema,
  VideoMaterialRefSchema,
]);
export type MaterialRef = z.infer<typeof MaterialRefSchema>;

export const FactRefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  factVersionId: UuidSchema,
  merchantId: UuidSchema.nullable(),
  statement: z.string().min(1),
});
export type FactRef = z.infer<typeof FactRefSchema>;

export const SlotBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("material"), materialId: UuidSchema }),
  z.strictObject({ kind: z.literal("fact"), factVersionId: UuidSchema }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("list"),
    items: z.array(z.string().min(1)).min(1),
  }),
  z
    .strictObject({
      kind: z.literal("table"),
      columns: z.array(z.string().min(1)).min(1),
      rows: z.array(z.array(z.string())),
    })
    .refine(
      (value) => value.rows.every((row) => row.length === value.columns.length),
      "绑定表格每行单元格数必须与列数一致",
    ),
]);
export type SlotBinding = z.infer<typeof SlotBindingSchema>;

export const InstantiateTemplateInputSchema = z.strictObject({
  templatePackage: TemplatePackageSchema,
  brief: BriefSchema,
  targetKind: ContentKindSchema,
  materials: z.array(MaterialRefSchema),
  facts: z.array(FactRefSchema),
  slotBindings: z.record(z.string(), SlotBindingSchema).optional(),
});
export type InstantiateTemplateInput = z.infer<typeof InstantiateTemplateInputSchema>;

const SlotTraceCommon = {
  slotId: z.string().min(1),
  source: z.enum(["brief", "material", "fact", "default", "binding"]),
  detail: z.string(),
};
export const SlotTraceSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...SlotTraceCommon, status: z.literal("placed"), blockId: UuidSchema, containerNodeId: UuidSchema }),
  z.strictObject({ ...SlotTraceCommon, status: z.literal("omitted") }),
]);
export type SlotTrace = z.infer<typeof SlotTraceSchema>;

export const TemplateInstanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: UuidSchema,
  contentId: UuidSchema,
  templateSnapshot: TemplatePackageSchema,
  ast: AstSchema,
  unplacedBlocks: z.array(BlockSchema),
  slotTrace: z.array(SlotTraceSchema),
  warnings: z.array(z.string()),
});
export type TemplateInstance = z.infer<typeof TemplateInstanceSchema>;

export const DeckDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  templateSnapshot: TemplatePackageSchema,
  ast: AstSchema.refine((ast) => ast.kind === "html_deck", "演示草稿必须是 html_deck"),
});
export type DeckDraft = z.infer<typeof DeckDraftSchema>;

export const ContrastEvidenceSchema = z.strictObject({
  textOnBackground: z.number().finite().nonnegative(),
  mutedOnBackground: z.number().finite().nonnegative(),
  accentTextOnAccent: z.number().finite().nonnegative(),
  minimum: z.number().finite().nonnegative(),
});
export type ContrastEvidence = z.infer<typeof ContrastEvidenceSchema>;

export const ReadyRenderEvidenceSchema = z.strictObject({
  source: z.literal("chromium"),
  rendererVersion: RendererVersionSchema,
  sampleHash: HashSchema,
  templateHash: HashSchema,
  astHash: HashSchema,
  loaded: z.literal(true),
  missingResources: z.array(z.string()),
  externalRequests: z.array(z.string()),
  overflow: z.strictObject({
    screen: z.boolean(),
    print: z.boolean(),
  }),
  print: z.strictObject({
    pages: z.number().int().positive(),
    pdfBytes: z.number().int().positive(),
    pdfSha256: HashSchema,
  }),
  contrast: ContrastEvidenceSchema,
  checkedAt: z.string().datetime({ offset: true }),
});
export type ReadyRenderEvidence = z.infer<typeof ReadyRenderEvidenceSchema>;

export const ValidationIssueSchema = z.strictObject({
  code: z.string().min(1),
  path: z.string().min(1),
  message: z.string().min(1),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationCheckSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
});
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

export const ReadyReviewSchema = z.strictObject({
  decision: z.enum(["pass", "blocked"]),
  recommendedStatus: z.literal("ready").nullable(),
  generatedAt: z.string().datetime({ offset: true }),
  checks: z.array(ValidationCheckSchema),
  evidenceHash: HashSchema.nullable(),
});
export type ReadyReview = z.infer<typeof ReadyReviewSchema>;

export const TemplateValidationResultSchema = z.strictObject({
  ok: z.boolean(),
  mode: z.enum(["schema", "draft", "ready", "export"]),
  package: TemplatePackageSchema.nullable(),
  checks: z.array(ValidationCheckSchema),
  issues: z.array(ValidationIssueSchema),
  readyReview: ReadyReviewSchema.nullable(),
});
export type TemplateValidationResult = z.infer<typeof TemplateValidationResultSchema>;

export const ValidateTemplateOptionsSchema = z.strictObject({
  mode: z.enum(["schema", "draft", "ready", "export"]).default("draft"),
  sample: z
    .strictObject({
      ast: AstSchema,
      media: z.record(z.string(), z.string()),
    })
    .optional(),
  evidence: ReadyRenderEvidenceSchema.optional(),
  instance: TemplateInstanceSchema.optional(),
  now: z.string().datetime({ offset: true }).optional(),
});
export type ValidateTemplateOptions = z.infer<typeof ValidateTemplateOptionsSchema>;

export const RenderInputSchema = z
  .strictObject({
    instance: TemplateInstanceSchema.optional(),
    templatePackage: TemplatePackageSchema.optional(),
    ast: AstSchema.optional(),
    media: z.record(z.string(), z.string()),
    sampleTitle: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.instance !== undefined) {
      if (value.templatePackage !== undefined || value.ast !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "instance 模式不能同时传入 templatePackage/ast",
        });
      }
      return;
    }
    if (value.templatePackage === undefined || value.ast === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "必须传入 instance，或同时传入 templatePackage 与 ast",
      });
      return;
    }
    if (value.templatePackage.manifest.kind !== value.ast.kind) {
      ctx.addIssue({
        code: "custom",
        message: "模板包与 AST 的输出类型不一致",
      });
    }
  });
export type RenderInput = z.infer<typeof RenderInputSchema>;

export const RenderResultSchema = z.strictObject({
  ok: z.boolean(),
  html: z.string(),
  artifactHash: HashSchema,
  resourcePaths: z.array(z.string()),
  issues: z.array(ValidationIssueSchema),
  kind: ContentKindSchema,
  templateVersionId: UuidSchema,
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

export const MediaKeySchema = z
  .string()
  .regex(/^(?:asset_version|derivative):[0-9a-f-]{36}$/);
export type MediaKey = z.infer<typeof MediaKeySchema>;

export const TemplateReadinessIssueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("duration_required"),
    path: z.literal("brief.durationMinutes"),
    templateVersionId: TemplateVersionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("goal_required"),
    path: z.literal("brief.goal"),
    templateVersionId: TemplateVersionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("tone_required"),
    path: z.literal("brief.tone"),
    templateVersionId: TemplateVersionIdSchema,
  }),
]);
export type TemplateReadinessIssue = z.infer<typeof TemplateReadinessIssueSchema>;

export const TemplateReadinessQuestionSchema = z.strictObject({
  index: z.int().nonnegative(),
  originalText: z.string(),
});
export type TemplateReadinessQuestion = z.infer<typeof TemplateReadinessQuestionSchema>;

export const TemplateReadinessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("waiting_input"),
    issues: z.array(TemplateReadinessIssueSchema),
    unresolvedQuestions: z.array(TemplateReadinessQuestionSchema),
  }),
]);
export type TemplateReadiness = z.infer<typeof TemplateReadinessSchema>;

export const TemplateStatusSchema = z.enum(["draft", "ready", "archived"]);
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;

export const TemplateValidationStatusSchema = z.enum([
  "not_validated",
  "queued",
  "running",
  "passed",
  "failed",
  "cancelled",
]);
export type TemplateValidationStatus = z.infer<typeof TemplateValidationStatusSchema>;

export const TemplateValidationRecordSchema = z.strictObject({
  id: UuidSchema,
  jobId: UuidSchema,
  status: TemplateValidationStatusSchema,
  packageHash: HashSchema,
  astHash: HashSchema.nullable(),
  sampleHash: HashSchema.nullable(),
  pdfPath: z.string().min(1).nullable(),
  pdfSha256: HashSchema.nullable(),
  report: TemplateValidationResultSchema.nullable(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type TemplateValidationRecord = z.infer<typeof TemplateValidationRecordSchema>;

export const TemplateSummarySchema = z.strictObject({
  id: UuidSchema,
  kind: ContentKindSchema,
  name: z.string(),
  narrativeId: NarrativeIdSchema,
  narrativeName: z.string(),
  narrativeSummary: z.string(),
  status: TemplateStatusSchema,
  currentVersionId: UuidSchema.nullable(),
  currentVersion: z.int().positive().nullable(),
  validationStatus: TemplateValidationStatusSchema,
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

export const TemplateListSchema = z.strictObject({
  items: z.array(TemplateSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
});
export type TemplateList = z.infer<typeof TemplateListSchema>;

export const TemplateVersionRecordSchema = z.strictObject({
  id: TemplateVersionIdSchema,
  templateId: UuidSchema,
  version: z.int().positive(),
  kind: ContentKindSchema,
  status: TemplateStatusSchema,
  baseVersionId: TemplateVersionIdSchema.nullable(),
  changeSummary: z.string().min(1),
  package: TemplatePackageSchema,
  packageHash: HashSchema,
  validation: TemplateValidationRecordSchema.nullable(),
  createdAt: UtcTimeSchema,
});
export type TemplateVersionRecord = z.infer<typeof TemplateVersionRecordSchema>;

export const TemplateVersionSummarySchema = z.strictObject({
  id: TemplateVersionIdSchema,
  version: z.int().positive(),
  status: TemplateStatusSchema,
  changeSummary: z.string(),
  packageHash: HashSchema,
  createdAt: UtcTimeSchema,
});
export type TemplateVersionSummary = z.infer<typeof TemplateVersionSummarySchema>;

export const TemplateDetailSchema = z.strictObject({
  summary: TemplateSummarySchema,
  version: TemplateVersionRecordSchema,
  versions: z.array(TemplateVersionSummarySchema),
});
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

export const CreateTemplateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  name: z.string().trim().min(1).max(200),
  kind: ContentKindSchema,
  narrativeId: NarrativeIdSchema.default("product-intro"),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;

export const CreateTemplateVersionRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  baseVersionId: TemplateVersionIdSchema,
  narrative: NarrativeDefinitionSchema,
  layouts: z.array(LayoutDefinitionSchema),
  theme: ThemeSchema,
  slots: z.array(TemplateSlotSchema).min(1),
  capabilities: CapabilitiesSchema,
  changeSummary: z.string().trim().min(1).max(500),
});
export type CreateTemplateVersionRequest = z.infer<typeof CreateTemplateVersionRequestSchema>;

export const ValidateTemplateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  versionId: TemplateVersionIdSchema,
});
export type ValidateTemplateRequest = z.infer<typeof ValidateTemplateRequestSchema>;

export const ValidateTemplateJobSchema = z.strictObject({
  jobId: UuidSchema,
  status: z.literal("queued"),
  versionId: TemplateVersionIdSchema,
});
export type ValidateTemplateJob = z.infer<typeof ValidateTemplateJobSchema>;

export const ArchiveTemplateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  versionId: TemplateVersionIdSchema,
  expectedStatus: TemplateStatusSchema.exclude(["archived"]),
});
export type ArchiveTemplateRequest = z.infer<typeof ArchiveTemplateRequestSchema>;

export const TemplateFromSourceRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  sourceVersionId: SourceVersionIdSchema,
  selection: z.strictObject({
    headingIds: z.array(z.string().min(1)).min(1),
  }),
  kind: ContentKindSchema,
});
export type TemplateFromSourceRequest = z.infer<typeof TemplateFromSourceRequestSchema>;

export const TemplateFromSourceResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("draft_created"),
    detail: TemplateDetailSchema,
    reviewRequired: z.literal(true),
  }),
  z.strictObject({
    status: z.literal("waiting_input"),
    reason: z.enum(["SOURCE_SECTIONS_UNAVAILABLE", "CONTENT_UNAVAILABLE"]),
    message: z.string(),
  }),
  z.strictObject({
    status: z.literal("blocked"),
    reason: z.enum(["MODEL_EXTRACTION_REQUIRED", "UNSUPPORTED_SOURCE"]),
    message: z.string(),
  }),
]);
export type TemplateFromSourceResult = z.infer<typeof TemplateFromSourceResultSchema>;

