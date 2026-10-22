import type {
  AuthoringOperation,
  Block,
  DeckLayout,
  Slide,
} from "@dmall/contracts";

export const DECK_LAYOUTS: Array<{ id: DeckLayout; label: string; hint: string }> = [
  { id: "cover", label: "封面", hint: "主题与一句话结论" },
  { id: "section", label: "章节页", hint: "叙事转场" },
  { id: "title-body-media", label: "图文页", hint: "标题、正文和主素材" },
  { id: "two-column", label: "双栏", hint: "对比或并列观点" },
  { id: "metric-evidence", label: "指标证据", hint: "大数字与来源" },
  { id: "steps", label: "步骤", hint: "流程与行动" },
  { id: "table", label: "表格", hint: "结构化对照" },
  { id: "closing", label: "结束页", hint: "下一步与行动请求" },
];

export function newSlide(layout: DeckLayout = "title-body-media"): Slide {
  return {
    id: crypto.randomUUID(),
    layout,
    title: "新页面",
    blocks: [],
    speakerNotes: "",
    locks: [],
  };
}

export function newParagraphBlock(slotId: string | null = null): Block {
  return {
    id: crypto.randomUUID(),
    type: "paragraph",
    inlines: [{ text: "", marks: [] }],
    provenance: [],
    locks: [],
    slotId,
  };
}

export function slideBody(slide: Slide): Block[] {
  return slide.blocks.filter((block) =>
    block.type === "paragraph" ||
    block.type === "callout" ||
    block.type === "list" ||
    block.type === "table" ||
    block.type === "image" ||
    block.type === "video" ||
    block.type === "readonly_source_block",
  );
}

export function createMoveOperation(input: {
  slide: Slide;
  blockId: string;
  direction: "up" | "down";
}): AuthoringOperation | null {
  const bodies = slideBody(input.slide);
  const index = bodies.findIndex((block) => block.id === input.blockId);
  if (index < 0) return null;
  const targetIndex = input.direction === "up" ? index - 1 : index + 1;
  const anchor = bodies[targetIndex];
  if (anchor === undefined) return null;
  return input.direction === "up"
    ? { op: "moveNode", nodeId: input.blockId, parentId: input.slide.id, beforeId: anchor.id }
    : { op: "moveNode", nodeId: input.blockId, parentId: input.slide.id, afterId: anchor.id };
}

export function fitLabel(value: "contain" | "cover"): string {
  return value === "contain" ? "完整显示" : "铺满裁切";
}
