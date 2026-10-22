import {
  LayoutDefinitionSchema,
  NarrativeDefinitionSchema,
  TemplatePackageSchema,
  type LayoutDefinition,
  type LayoutId,
  type NarrativeDefinition,
  type NarrativeId,
  type NarrativeSection,
  type TemplatePackage,
  type TemplateSlot,
} from "@dmall/contracts";
import { stableUuid } from "./ids.js";

export const TEMPLATE_SCHEMA_VERSION = 1;
export const DECK_CANVAS = { width: 1600, height: 900 } as const;
export const SAMPLE_DATA_LABEL = "合成示意 · 非真实材料";

const VIOLET_THEME = {
  id: "violet-glass",
  name: "Violet Glass",
  palette: {
    background: "#0d0b1f",
    backgroundAlt: "#171238",
    surface: "#241c50",
    surfaceStrong: "#30256a",
    text: "#f7f4ff",
    muted: "#c9c2e8",
    accent: "#6d3fe0",
    accentStrong: "#5630ba",
    accentText: "#ffffff",
    border: "#7560c8",
    success: "#5ee0a8",
    warning: "#f3bf68",
  },
  typography: {
    heading: "ui-sans",
    body: "ui-sans",
    mono: "ui-mono",
  },
  radius: {
    panel: 24,
    card: 18,
    control: 12,
  },
  glass: {
    surfaceOpacity: 0.74,
    borderOpacity: 0.72,
    blurPx: 18,
  },
} as const;

const layoutSlot = {
  paragraph: (id: string, label: string, required: boolean, maxCharacters: number) => ({
    id,
    label,
    blockTypes: ["paragraph"] as const,
    required,
    maxCharacters,
  }),
  media: (id: string, label: string, required: boolean) => ({
    id,
    label,
    blockTypes: ["image"] as const,
    required,
    maxItems: 1,
  }),
  list: (id: string, label: string, required: boolean, maxItems: number, maxCharacters: number) => ({
    id,
    label,
    blockTypes: ["list"] as const,
    required,
    maxItems,
    maxCharacters,
  }),
  table: (id: string, label: string, required: boolean, maxRows: number, maxCharacters: number) => ({
    id,
    label,
    blockTypes: ["table"] as const,
    required,
    maxRows,
    maxCharacters,
  }),
  callout: (id: string, label: string, required: boolean, maxCharacters: number) => ({
    id,
    label,
    blockTypes: ["callout"] as const,
    required,
    maxCharacters,
  }),
};

export const registeredLayouts: readonly LayoutDefinition[] = [
  LayoutDefinitionSchema.parse({
    id: "cover",
    name: "封面",
    description: "标题、结论句和合成示意标记，用于开场。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [layoutSlot.paragraph("subtitle", "副标题", true, 80)],
  }),
  LayoutDefinitionSchema.parse({
    id: "section",
    name: "章节",
    description: "一个章节标题加一段导语，用于切换叙事主题。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [layoutSlot.paragraph("intro", "章节导语", true, 120)],
  }),
  LayoutDefinitionSchema.parse({
    id: "title-body-media",
    name: "图文主体",
    description: "左侧正文、右侧显式素材；没有素材时保留文字区域。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [
      layoutSlot.paragraph("body", "正文", true, 180),
      layoutSlot.media("media", "证据图片", false),
    ],
  }),
  LayoutDefinitionSchema.parse({
    id: "two-column",
    name: "双栏对照",
    description: "两列并列表达现状与方案、问题与行动。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [
      layoutSlot.paragraph("left", "左栏", true, 80),
      layoutSlot.paragraph("right", "右栏", true, 80),
    ],
  }),
  LayoutDefinitionSchema.parse({
    id: "metric-evidence",
    name: "指标与证据",
    description: "突出一个来源明确的指标，并给出证据图片与解释。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [
      layoutSlot.callout("metric", "指标", true, 60),
      layoutSlot.media("evidence", "证据图片", false),
      layoutSlot.paragraph("explanation", "解释", true, 120),
    ],
  }),
  LayoutDefinitionSchema.parse({
    id: "steps",
    name: "步骤",
    description: "三到五步的推进路径，每条控制为短句。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [layoutSlot.list("steps", "步骤列表", true, 5, 36)],
  }),
  LayoutDefinitionSchema.parse({
    id: "table",
    name: "表格",
    description: "受控矩形表格，只允许简单单元格文本。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [layoutSlot.table("data", "数据表", true, 6, 24)],
  }),
  LayoutDefinitionSchema.parse({
    id: "closing",
    name: "收束",
    description: "列出下一步和讨论事项，结束演示。",
    canvas: DECK_CANVAS,
    titleMaxCharacters: 28,
    slots: [layoutSlot.list("next", "下一步", true, 4, 36)],
  }),
] as const;

const LAYOUTS_BY_ID = new Map<LayoutId, LayoutDefinition>(
  registeredLayouts.map((layout) => [layout.id, layout]),
);

export function getRegisteredLayout(layoutId: LayoutId): LayoutDefinition {
  const layout = LAYOUTS_BY_ID.get(layoutId);
  if (layout === undefined) {
    throw new Error(`未注册版式: ${layoutId}`);
  }
  return layout;
}

interface NarrativeInput {
  id: NarrativeId;
  name: string;
  summary: string;
  sections: readonly { id: string; title: string; purpose: string; evidence: readonly string[] }[];
}

function deckSlidesFor(input: NarrativeInput): NarrativeDefinition["deck"]["slides"] {
  const section = (index: number): NarrativeSection => {
    const found = input.sections[index] ?? input.sections[input.sections.length - 1];
    if (found === undefined) throw new Error("叙事至少需要一个章节");
    return {
      id: found.id,
      title: found.title,
      purpose: found.purpose,
      requiredEvidence: [...found.evidence],
    };
  };
  return [
    {
      id: "cover",
      layout: "cover",
      title: input.name,
      purpose: "说明本演示的适用场景和结论边界。",
    },
    {
      id: "context",
      layout: "section",
      title: section(0).title,
      purpose: section(0).purpose,
    },
    {
      id: "detail",
      layout: "title-body-media",
      title: section(1).title,
      purpose: section(1).purpose,
    },
    {
      id: "compare",
      layout: "two-column",
      title: section(2).title,
      purpose: section(2).purpose,
    },
    {
      id: "metric",
      layout: "metric-evidence",
      title: section(3).title,
      purpose: "展示显式事实绑定和可追溯证据。",
    },
    ...input.sections.slice(4, -1).map(item => ({
      id: `narrative-${item.id}`,
      layout: "title-body-media" as const,
      title: item.title,
      purpose: item.purpose,
    })),
    {
      id: "steps",
      layout: "steps",
      title: "推进步骤",
      purpose: "把结论拆为可执行步骤，不引入未提供的事实。",
    },
    {
      id: "evidence",
      layout: "table",
      title: "证据清单",
      purpose: "汇总证据与待补项，控制为简单表格。",
    },
    {
      id: "closing",
      layout: "closing",
      title: section(input.sections.length - 1).title,
      purpose: "收束到下一步和待确认问题。",
    },
  ];
}

function narrative(input: NarrativeInput): NarrativeDefinition {
  return NarrativeDefinitionSchema.parse({
    id: input.id,
    name: input.name,
    summary: input.summary,
    doc: {
      sections: input.sections.map((item) => ({
        id: item.id,
        title: item.title,
        purpose: item.purpose,
        requiredEvidence: [...item.evidence],
      })),
    },
    deck: {
      slides: deckSlidesFor(input),
    },
  });
}

export const builtinNarratives: readonly NarrativeDefinition[] = [
  narrative({
    id: "product-intro",
    name: "客户产品介绍",
    summary: "从经营问题进入产品定位，再展示场景、价值和边界。",
    sections: [
      { id: "problem", title: "经营问题", purpose: "说明客户当前面对的具体经营问题。", evidence: ["客户访谈", "现状数据"] },
      { id: "positioning", title: "产品定位", purpose: "说明产品边界、适用对象和不承诺的能力。", evidence: ["产品说明"] },
      { id: "scenario", title: "场景演示", purpose: "用显式素材展示一个真实操作场景。", evidence: ["截图", "录屏静帧"] },
      { id: "value", title: "价值与边界", purpose: "给出可核验价值，同时明确限制。", evidence: ["测算口径", "事实版本"] },
      { id: "next", title: "下一步", purpose: "列出试点、验收和待确认事项。", evidence: ["行动负责人"] },
    ],
  }),
  narrative({
    id: "executive-progress",
    name: "管理层进展汇报",
    summary: "先给结论，再用证据、案例、风险和计划支撑。",
    sections: [
      { id: "conclusion", title: "本期结论", purpose: "先回答本期是否达成目标。", evidence: ["指标快照"] },
      { id: "value", title: "使用与价值证据", purpose: "展示采用情况和有来源的价值证据。", evidence: ["使用记录", "事实版本"] },
      { id: "case", title: "客户案例", purpose: "用一个案例解释变化机制，不夸大结果。", evidence: ["案例素材"] },
      { id: "risk", title: "风险", purpose: "列出风险、依赖和当前缓解动作。", evidence: ["风险台账"] },
      { id: "plan", title: "下期计划", purpose: "说明下期目标、里程碑和验收口径。", evidence: ["计划表"] },
    ],
  }),
  narrative({
    id: "phase-review",
    name: "阶段成果复盘",
    summary: "按目标、交付、采用、证据、差距、行动复盘阶段成果。",
    sections: [
      { id: "objective", title: "目标", purpose: "复述阶段目标和验收口径。", evidence: ["立项记录"] },
      { id: "delivery", title: "交付", purpose: "列出实际交付物和未完成项。", evidence: ["交付清单"] },
      { id: "adoption", title: "采用情况", purpose: "说明谁在使用、如何使用。", evidence: ["使用数据"] },
      { id: "evidence", title: "证据", purpose: "呈现可追溯事实，不把推断写成结论。", evidence: ["事实版本", "来源定位"] },
      { id: "gap", title: "差距", purpose: "解释目标与结果之间的差距。", evidence: ["差距分析"] },
      { id: "action", title: "行动", purpose: "给出下一步动作和负责人。", evidence: ["行动表"] },
    ],
  }),
  narrative({
    id: "merchant-solution",
    name: "商家解决方案",
    summary: "从商家现状进入方案演示，再落到实施和验收。",
    sections: [
      { id: "current", title: "商家现状", purpose: "描述已确认的商家场景和约束。", evidence: ["商家访谈"] },
      { id: "goal", title: "场景目标", purpose: "明确要改善的业务动作和验收方式。", evidence: ["目标口径"] },
      { id: "solution", title: "方案", purpose: "说明方案组成、依赖和不适用范围。", evidence: ["方案说明"] },
      { id: "demo", title: "演示", purpose: "用显式素材展示关键流程。", evidence: ["截图", "录屏静帧"] },
      { id: "acceptance", title: "实施与验收", purpose: "列出实施步骤、验收标准和回退方式。", evidence: ["验收表"] },
    ],
  }),
  narrative({
    id: "internal-sharing",
    name: "内部分享",
    summary: "从问题、机制、实例和经验展开，最后收集讨论。",
    sections: [
      { id: "question", title: "问题", purpose: "提出一个值得讨论的具体问题。", evidence: ["背景材料"] },
      { id: "mechanism", title: "机制", purpose: "解释问题背后的机制和假设。", evidence: ["机制说明"] },
      { id: "example", title: "实例", purpose: "用带来源的实例检验机制。", evidence: ["案例素材"] },
      { id: "lesson", title: "经验", purpose: "总结可复用经验和适用边界。", evidence: ["复盘记录"] },
      { id: "discussion", title: "讨论", purpose: "列出需要同事判断的问题。", evidence: [] },
    ],
  }),
  narrative({
    id: "training",
    name: "用户培训",
    summary: "按入口、基础提问、连续任务、注意事项和练习组织培训。",
    sections: [
      { id: "entry", title: "入口", purpose: "说明从哪里进入以及前置条件。", evidence: ["操作截图"] },
      { id: "prompt", title: "基础提问", purpose: "演示一次清晰的提问和结果。", evidence: ["示例对话"] },
      { id: "flow", title: "连续任务", purpose: "说明连续任务如何保留上下文。", evidence: ["连续操作示例"] },
      { id: "caution", title: "注意事项", purpose: "列出权限、事实和素材使用边界。", evidence: ["规范说明"] },
      { id: "exercise", title: "练习", purpose: "给出可自行完成的练习和检查点。", evidence: ["练习题"] },
    ],
  }),
] as const;

function findNarrative(narrativeId: NarrativeId): NarrativeDefinition {
  const found = builtinNarratives.find((item) => item.id === narrativeId);
  if (found === undefined) throw new Error(`未知叙事: ${narrativeId}`);
  return found;
}

function docSlotsFor(narrativeDefinition: NarrativeDefinition): TemplateSlot[] {
  return narrativeDefinition.doc.sections.flatMap((section) => [
    {
      id: `${section.id}-body`,
      containerId: section.id,
      order: 0,
      label: `${section.title}正文`,
      blockType: "paragraph",
      required: true,
      capacity: { maxCharacters: 500, maxItems: 1 },
      source: {
        kind: "default",
        value: {
          kind: "text",
          text: `待补充：${section.title}内容须绑定明确来源。`,
        },
      },
    },
    {
      id: `${section.id}-evidence`,
      containerId: section.id,
      order: 1,
      label: `${section.title}证据图`,
      blockType: "image",
      required: false,
      capacity: { maxItems: 1 },
      source: {
        kind: "material",
        mediaKind: "image",
      },
    },
  ]);
}

function deckSlot(
  slideId: string,
  layoutSlotId: string,
  order: number,
  listSlot: LayoutDefinition["slots"][number],
): TemplateSlot {
  const id = `${slideId}-${layoutSlotId}`;
  const common = {
    id,
    containerId: slideId,
    layoutSlotId,
    order,
    label: listSlot.label,
    required: listSlot.required,
    capacity: {
      ...(listSlot.maxCharacters === undefined
        ? {}
        : { maxCharacters: listSlot.maxCharacters }),
      ...(listSlot.maxItems === undefined ? {} : { maxItems: listSlot.maxItems }),
      ...(listSlot.maxRows === undefined ? {} : { maxRows: listSlot.maxRows }),
    },
  };
  switch (listSlot.blockTypes[0]) {
    case "paragraph":
      return {
        ...common,
        blockType: "paragraph",
        source: {
          kind: "default",
          value: {
            kind: "text",
            text:
              listSlot.id === "subtitle"
                ? "一页看清适用范围、证据边界和下一步。"
                : listSlot.id === "intro"
                  ? "本节只陈述已确认事实，未确认内容保留待补。"
                  : listSlot.id === "left"
                    ? "现状：用一句话描述已经确认的问题。"
                    : listSlot.id === "right"
                      ? "方案：用一句话描述对应的处理方式。"
                      : "正文待补充，不得用猜测替代来源。",
          },
        },
      };
    case "image":
      return {
        ...common,
        blockType: "image",
        source: { kind: "material", mediaKind: "image" },
      };
    case "list":
      return {
        ...common,
        blockType: "list",
        source: {
          kind: "default",
          value: {
            kind: "list",
            items:
              listSlot.id === "next"
                ? ["确认下一步负责人", "安排一次验收", "记录待补证据"]
                : ["确认目标与边界", "执行一个小范围试点", "用证据复盘结果"],
          },
        },
      };
    case "table":
      return {
        ...common,
        blockType: "table",
        source: {
          kind: "default",
          value: {
            kind: "table",
            columns: ["维度", "说明"],
            rows: [
              ["目标", "待绑定明确来源"],
              ["证据", "待绑定素材或事实"],
            ],
          },
        },
      };
    case "callout":
      return {
        ...common,
        blockType: "callout",
        source: {
          kind: "default",
          value: {
            kind: "text",
            text: "指标待绑定 factVersion，不接受估算值。",
          },
        },
      };
    default:
      throw new Error(`不支持的版式槽位类型: ${listSlot.blockTypes[0] ?? "empty"}`);
  }
}

function deckSlotsFor(narrativeDefinition: NarrativeDefinition): TemplateSlot[] {
  return narrativeDefinition.deck.slides.flatMap((slide) => {
    const layout = getRegisteredLayout(slide.layout);
    return layout.slots.map((slot, index) =>
      deckSlot(slide.id, slot.id, index, slot),
    );
  });
}

export function buildBuiltinTemplatePackage(
  narrativeId: NarrativeId,
  kind: "feishu_doc" | "html_deck",
): TemplatePackage {
  const narrativeDefinition = findNarrative(narrativeId);
  const packageKey = `${kind}:${narrativeId}`;
  const now = "2026-10-21T00:00:00.000Z";
  return TemplatePackageSchema.parse({
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    manifest: {
      id: stableUuid(`template:${narrativeId}`),
      templateVersionId: stableUuid(`template-version:${packageKey}:1`),
      name: `${narrativeDefinition.name}${kind === "feishu_doc" ? "文档" : "演示"}`,
      version: 1,
      status: "draft",
      kind,
      narrativeId,
      previousVersionId: null,
      changeSummary: "内置初稿",
      customerSpecificDefaults: false,
      createdAt: now,
      updatedAt: now,
    },
    narrative: narrativeDefinition,
    layouts: kind === "html_deck" ? [...registeredLayouts] : [],
    theme: VIOLET_THEME,
    capabilities: {
      editableText: true,
      simpleTable: true,
      video: "poster_only",
      rawHtml: false,
      userScript: false,
      remoteAssets: false,
      remoteFonts: false,
    },
    slots:
      kind === "feishu_doc"
        ? docSlotsFor(narrativeDefinition)
        : deckSlotsFor(narrativeDefinition),
    rendererVersion: kind === "feishu_doc" ? "docx-1" : "deck-1",
  });
}

export const builtinTemplatePackages: readonly TemplatePackage[] =
  builtinNarratives.flatMap((item) => [
    buildBuiltinTemplatePackage(item.id, "feishu_doc"),
    buildBuiltinTemplatePackage(item.id, "html_deck"),
  ]);
