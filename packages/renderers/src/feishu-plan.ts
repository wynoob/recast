import type {
  Ast,
  Block,
  DeckAst,
  DocAst,
  Inlines,
} from "@dmall/contracts";

export interface FeishuRun {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: string | null;
}

export type FeishuPlannedBlock =
  | {
      kind: "heading";
      nodeId: string;
      level: number;
      runs: FeishuRun[];
    }
  | {
      kind: "paragraph";
      nodeId: string;
      runs: FeishuRun[];
    }
  | {
      kind: "list";
      nodeId: string;
      ordered: boolean;
      items: FeishuRun[][];
    }
  | {
      kind: "callout";
      nodeId: string;
      runs: FeishuRun[];
    }
  | {
      kind: "divider";
      nodeId: string;
    }
  | {
      kind: "image";
      nodeId: string;
      mediaKey: string;
      caption: string;
      alt: string;
    }
  | {
      kind: "video_poster";
      nodeId: string;
      mediaKey: string;
      caption: string;
      playbackLink: string | null;
    }
  | {
      kind: "table";
      nodeId: string;
      columns: string[];
      rows: string[][];
    }
  | {
      kind: "readonly_source";
      nodeId: string;
      summary: string;
      sourceBlockType: string;
      url: string | null;
    };

export interface FeishuPublishPlan {
  schemaVersion: 1;
  title: string;
  blocks: FeishuPlannedBlock[];
  warnings: Array<{ code: string; message: string }>;
}

function safeFeishuLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
    return value;
  } catch {
    return null;
  }
}

function runs(inlines: Inlines): FeishuRun[] {
  return inlines.map((inline) => {
    let bold = false;
    let italic = false;
    let code = false;
    let link: string | null = null;
    for (const mark of inline.marks) {
      if (mark === "bold") bold = true;
      else if (mark === "italic") italic = true;
      else if (mark === "code") code = true;
      else if (typeof mark === "object" && mark.type === "link") {
        link = safeFeishuLink(mark.href);
      }
    }
    return { text: inline.text, bold, italic, code, link };
  });
}

function plainRuns(runsValue: FeishuRun[]): string {
  return runsValue.map((run) => run.text).join("");
}

function plannedBlock(block: Block, warnings: FeishuPublishPlan["warnings"]): FeishuPlannedBlock | null {
  switch (block.type) {
    case "heading":
      return {
        kind: "heading",
        nodeId: block.id,
        level: block.level,
        runs: [{ text: block.text, bold: false, italic: false, code: false, link: null }],
      };
    case "paragraph":
      return { kind: "paragraph", nodeId: block.id, runs: runs(block.inlines) };
    case "list":
      return {
        kind: "list",
        nodeId: block.id,
        ordered: block.ordered,
        items: block.items.map(runs),
      };
    case "callout":
      return { kind: "callout", nodeId: block.id, runs: runs(block.inlines) };
    case "divider":
      return { kind: "divider", nodeId: block.id };
    case "image":
      return {
        kind: "image",
        nodeId: block.id,
        mediaKey: block.derivativeId === null
          ? `asset_version:${block.assetVersionId}`
          : `derivative:${block.derivativeId}`,
        caption: block.caption,
        alt: block.alt,
      };
    case "video":
      warnings.push({
        code: "FEISHU_VIDEO_STATIC",
        message: `视频块 ${block.id} 在飞书文档中输出为封面帧和说明`,
      });
      return {
        kind: "video_poster",
        nodeId: block.id,
        mediaKey: `derivative:${block.posterDerivativeId}`,
        caption: block.caption,
        playbackLink: null,
      };
    case "table":
      return {
        kind: "table",
        nodeId: block.id,
        columns: block.columns,
        rows: block.rows.map((row) => row.map((cell) => plainRuns(runs(cell)))),
      };
    case "readonly_source_block":
      warnings.push({
        code: "FEISHU_READONLY_SOURCE",
        message: `只读来源块 ${block.id} 以文字摘要输出，不执行远端原始内容`,
      });
      return {
        kind: "readonly_source",
        nodeId: block.id,
        summary: block.summary,
        sourceBlockType: block.sourceBlockType,
        url: safeFeishuLink(block.sourceUrl),
      };
  }
}

export function buildFeishuPublishPlan(
  ast: Ast,
  options?: { includeSpeakerNotes?: boolean },
): FeishuPublishPlan {
  const warnings: FeishuPublishPlan["warnings"] = [];
  const blocks: FeishuPlannedBlock[] = [];
  if (ast.kind === "feishu_doc") {
    for (const section of ast.sections) {
      blocks.push({
        kind: "heading",
        nodeId: section.id,
        level: 1,
        runs: [{ text: section.title, bold: false, italic: false, code: false, link: null }],
      });
      for (const block of section.blocks) {
        const planned = plannedBlock(block, warnings);
        if (planned !== null) blocks.push(planned);
      }
      const notes = ast.speakerNotes[section.id];
      if (options?.includeSpeakerNotes === true && notes !== undefined && notes.trim() !== "") {
        blocks.push({
          kind: "paragraph",
          nodeId: `${section.id}-speaker-notes`,
          runs: [{ text: `讲稿：${notes}`, bold: false, italic: true, code: false, link: null }],
        });
      }
    }
  } else {
    for (const slide of ast.slides) {
      blocks.push({
        kind: "heading",
        nodeId: slide.id,
        level: 1,
        runs: [{ text: slide.title, bold: false, italic: false, code: false, link: null }],
      });
      for (const block of slide.blocks) {
        const planned = plannedBlock(block, warnings);
        if (planned !== null) blocks.push(planned);
      }
      if (options?.includeSpeakerNotes === true && slide.speakerNotes.trim() !== "") {
        blocks.push({
          kind: "paragraph",
          nodeId: `${slide.id}-speaker-notes`,
          runs: [{ text: `讲稿：${slide.speakerNotes}`, bold: false, italic: true, code: false, link: null }],
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    title: ast.title,
    blocks,
    warnings,
  };
}

export function planMediaKeys(plan: FeishuPublishPlan): string[] {
  const keys = new Set<string>();
  for (const block of plan.blocks) {
    if (block.kind === "image" || block.kind === "video_poster") keys.add(block.mediaKey);
  }
  return [...keys].sort();
}

export function planTextRuns(block: FeishuPlannedBlock): FeishuRun[] {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "callout":
      return block.runs;
    case "list":
      return block.items.flat();
    default:
      return [];
  }
}

export function extractBlockOrder(ast: Ast): string[] {
  if (ast.kind === "feishu_doc") {
    return ast.sections.flatMap((section) => [section.id, ...section.blocks.map((block) => block.id)]);
  }
  return ast.slides.flatMap((slide) => [slide.id, ...slide.blocks.map((block) => block.id)]);
}

export function astTitle(ast: Ast): string {
  return ast.title;
}

export function astBlockCount(ast: Ast): number {
  return ast.kind === "feishu_doc"
    ? ast.sections.reduce((total, section) => total + section.blocks.length, 0)
    : ast.slides.reduce((total, slide) => total + slide.blocks.length, 0);
}

export type { Ast, DeckAst, DocAst };
