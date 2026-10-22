import { createHash } from "node:crypto";
import {
  NodeIdSchema,
  type Ast,
  type AuthoringOperation,
  type Block,
  type Claim,
  type FixedEvidence,
  type LayoutSlot,
  type Proposal,
  type Provenance,
  type SlotCapacity,
  type TemplatePackage,
  type TemplateSlot,
  type WholeDraft,
} from "@dmall/contracts";
import { applyEditOperations, validateAst } from "@dmall/domain";
import { canonicalHash } from "@dmall/templates";
import { ApiError } from "../errors.js";
import { templateAstValid } from "./template-check.js";

type BodyPart = Extract<WholeDraft, { kind: "feishu_doc" }>["sections"][number]["parts"][number]
  | Extract<WholeDraft, { kind: "html_deck" }>["slides"][number]["parts"][number];

export function compileCompositionDraft(input: {
  body: WholeDraft;
  proposal: Proposal;
  templatePackage: TemplatePackage;
  evidence: readonly FixedEvidence[];
  rootNodeId: string;
  baseAst: Ast;
  generationInputId: string;
}): { operations: AuthoringOperation[]; claims: Claim[] } {
  const { body, proposal, templatePackage: pkg, baseAst } = input;
  if (body.kind !== proposal.delivery.kind || body.kind !== baseAst.kind || body.kind !== pkg.manifest.kind) {
    invalid("正文、方案、基线和模板的类型不一致");
  }
  if (body.title !== proposal.title) invalid("正文标题与确认方案不一致");
  if (!validateAst(baseAst).ok || (baseAst.kind === "feishu_doc" ? baseAst.sections.length : baseAst.slides.length) !== 0) {
    invalid("正文转换需要合法空稿基线");
  }
  if (pkg.manifest.status === "archived" || pkg.manifest.templateVersionId !== proposal.template.versionId ||
      canonicalHash(pkg) !== proposal.template.packageHash) {
    throw new ApiError({ statusCode: 422, code: "TEMPLATE_INVALID", message: "固定模板与确认方案不一致" });
  }
  const evidenceById = new Map(input.evidence.map((item) => [item.evidenceId, item]));
  const available = new Map(proposal.evidence.map((item) => [item.id, item]));
  const resolve = (id: string): FixedEvidence => {
    const fixed = evidenceById.get(id);
    const summary = available.get(id);
    if (fixed === undefined || summary?.availability !== "available" || summary.kind !== fixed.kind) {
      throw new ApiError({ statusCode: 422, code: "UNKNOWN_REFERENCE", message: "正文引用了未确认或不可用的证据", details: { evidenceId: id } });
    }
    return fixed;
  };
  const nodeId = (...path: string[]) => stableNodeId(JSON.stringify([input.generationInputId, body.kind, ...path]));
  const operations: AuthoringOperation[] = [];
  const claims: Claim[] = [];
  if (baseAst.title !== body.title) {
    operations.push({ op: "setField", nodeId: NodeIdSchema.parse(input.rootNodeId), path: "title", value: body.title });
  }

  const buildParts = (
    key: string,
    parts: readonly BodyPart[],
    placements: readonly { evidenceId: string; templateSlotKey?: string }[],
    slots: TemplateSlot[],
    layoutSlots?: readonly LayoutSlot[],
  ): Block[] => {
    uniqueKeys(parts, "正文块");
    const used = new Map<string, number>();
    const layoutUsed = new Map<string, number>();
    const images = new Set<string>();
    const blocks = parts.map((part) => {
      const id = nodeId(key, "part", part.key);
      const fixed = part.kind === "image" ? [resolve(part.evidenceId)] : [...new Set(part.sources)].map(resolve);
      const provenance = fixed.flatMap(provenanceFor);
      const common = { id, provenance: deduplicateProvenance(provenance), locks: [] };
      let block: Block;
      switch (part.kind) {
        case "paragraph":
          if (part.text.trim() === "") invalid("段落正文不能为空");
          block = { ...common, type: "paragraph", inlines: inline(part.text) };
          break;
        case "list":
          if (part.items.length === 0 || part.items.some((item) => item.trim() === "")) invalid("列表正文不能为空");
          block = { ...common, type: "list", ordered: false, items: part.items.map(inline) };
          break;
        case "table":
          if (part.columns.length === 0 || part.rows.length === 0 || part.rows.some((row) => row.length !== part.columns.length)) {
            invalid("表格每行列数必须与表头一致，且必须有正文行");
          }
          block = { ...common, type: "table", columns: part.columns, rows: part.rows.map((row) => row.map(inline)) };
          break;
        case "image": {
          const media = resolve(part.evidenceId);
          const slotKey = "templateSlotKey" in part ? part.templateSlotKey : undefined;
          if (!placements.some((placement) => placement.evidenceId === part.evidenceId &&
              (layoutSlots === undefined || placement.templateSlotKey === slotKey))) {
            invalid("图片位置与确认方案不一致");
          }
          images.add(JSON.stringify([part.evidenceId, slotKey]));
          if (media.kind !== "media" || media.occurrence === null) invalid("图片必须引用有来源定位的固定媒体");
          if (media.mediaKind === "video") {
            if (media.poster === null) invalid("视频素材缺少固定封面");
            block = { ...common, type: "video", assetVersionId: media.assetVersionId,
              segmentId: media.segment?.id ?? null, posterDerivativeId: media.poster.id, caption: part.caption };
          } else {
            block = { ...common, type: "image", assetVersionId: media.assetVersionId,
              derivativeId: media.derivative?.id ?? null, occurrenceId: media.occurrence.requestedOccurrenceId,
              caption: part.caption, alt: part.caption, fit: "contain" };
          }
          break;
        }
        default: {
          const exhaustive: never = part;
          return exhaustive;
        }
      }
      const slot = layoutSlots === undefined
        ? slots.filter((item) => item.blockType === block.type && withinCapacity(block, item.capacity) &&
            (used.get(item.id) ?? 0) < (item.capacity.maxItems ?? 1))
          .sort((a, b) => Number(b.required && !used.has(b.id)) - Number(a.required && !used.has(a.id)) || a.order - b.order)[0]
        : slots.find((item) => "templateSlotKey" in part && item.id === part.templateSlotKey);
      if (slot === undefined || slot.blockType !== block.type || !withinCapacity(block, slot.capacity)) {
        invalid("正文不符合模板槽位的类型或容量");
      }
      const count = (used.get(slot.id) ?? 0) + 1;
      if (count > (slot.capacity.maxItems ?? 1)) invalid("模板槽位块数超出容量");
      used.set(slot.id, count);
      if (layoutSlots !== undefined) {
        const layoutSlot = layoutSlots.find((item) => item.id === slot.layoutSlotId);
        if (layoutSlot === undefined || !layoutSlot.blockTypes.some((type) => type === block.type) || !withinCapacity(block, layoutSlot)) {
          invalid("正文不符合演示版式槽位的类型或容量");
        }
        const count = (layoutUsed.get(layoutSlot.id) ?? 0) + 1;
        if (count > (layoutSlot.maxItems ?? 1)) invalid("演示版式槽位块数超出容量");
        layoutUsed.set(layoutSlot.id, count);
        block = { ...block, slotId: layoutSlot.id };
      }
      if (part.kind !== "image") claims.push(...claimsFor(block, part, fixed));
      return block;
    });
    if (slots.some((slot) => slot.required && !used.has(slot.id)) ||
        layoutSlots?.some((slot) => slot.required && !layoutUsed.has(slot.id))) {
      invalid("正文缺少模板或版式必填内容");
    }
    for (const placement of placements) {
      if (resolve(placement.evidenceId).kind === "media" &&
          !images.has(JSON.stringify([placement.evidenceId, layoutSlots === undefined ? undefined : placement.templateSlotKey]))) {
        invalid("正文缺少方案安排的图片");
      }
    }
    return blocks;
  };

  if (body.kind === "feishu_doc" && "sections" in proposal) {
    sameKeys(body.sections, proposal.sections);
    for (const [index, section] of body.sections.entries()) {
      const planned = proposal.sections[index];
      if (planned === undefined || section.heading !== planned.heading ||
          !pkg.narrative.doc.sections.some((item) => item.id === planned.templateContainerKey)) {
        invalid("文档章节标题或模板容器与方案不一致");
      }
      operations.push({ op: "insertNode", parentId: NodeIdSchema.parse(input.rootNodeId), afterId: null,
        node: { id: nodeId(section.key, "container"), title: section.heading, locks: [],
          blocks: buildParts(section.key, section.parts, planned.placements, pkg.slots.filter((slot) => slot.containerId === planned.templateContainerKey)) } });
    }
  } else if (body.kind === "html_deck" && "slides" in proposal) {
    sameKeys(body.slides, proposal.slides);
    for (const [index, slide] of body.slides.entries()) {
      const planned = proposal.slides[index];
      if (planned === undefined || slide.title !== planned.title || slide.templateContainerKey !== planned.templateContainerKey || slide.layoutKey !== planned.layoutKey) {
        invalid("演示页标题、容器或版式与方案不一致");
      }
      const container = pkg.narrative.deck.slides.find((item) => item.id === slide.templateContainerKey);
      const layout = pkg.layouts.find((item) => item.id === slide.layoutKey);
      if (container === undefined || layout === undefined || container.layout !== layout.id || slide.title.length > layout.titleMaxCharacters) {
        invalid("演示页版式或标题容量不符合模板");
      }
      operations.push({ op: "insertNode", parentId: NodeIdSchema.parse(input.rootNodeId), afterId: null,
        node: { id: nodeId(slide.key, "container"), title: slide.title, layout: layout.id, speakerNotes: slide.speakerNotes, locks: [],
          blocks: buildParts(slide.key, slide.parts, planned.placements, pkg.slots.filter((slot) => slot.containerId === container.id), layout.slots) } });
    }
  } else {
    invalid("正文结构与确认方案不一致");
  }
  const applied = applyEditOperations({ ast: baseAst, operations, rules: { rootNodeId: input.rootNodeId, actor: "ai" } });
  if (!applied.ok) invalid(applied.violations[0]?.message ?? "正文操作无法应用到空稿");
  if (!templateAstValid(pkg, applied.ast)) invalid("正文不符合现有候选的模板归属约束");
  return { operations, claims };
}

function invalid(message: string): never {
  throw new ApiError({ statusCode: 422, code: "DRAFT_INVALID", message });
}

function uniqueKeys(items: readonly { key: string }[], label: string): void {
  if (items.some((item) => item.key.trim() === "") || new Set(items.map((item) => item.key)).size !== items.length) {
    invalid(`${label}的业务 key 为空或重复`);
  }
}

function sameKeys(actual: readonly { key: string }[], expected: readonly { key: string }[]): void {
  uniqueKeys(actual, "章节或页面");
  uniqueKeys(expected, "确认方案");
  if (actual.length === 0 || actual.length !== expected.length || actual.some((item, index) => item.key !== expected[index]?.key)) {
    invalid("章节或页面 key、数量、顺序与确认方案不一致");
  }
}

function inline(text: string) {
  return [{ text, marks: [] }];
}

function withinCapacity(block: Block, capacity: SlotCapacity): boolean {
  const { maxCharacters } = capacity;
  const texts = block.type === "paragraph" ? [block.inlines.map((item) => item.text).join("")]
    : block.type === "list" ? block.items.map((items) => items.map((item) => item.text).join(""))
      : block.type === "table" ? [...block.columns, ...block.rows.flatMap((row) => row.map((items) => items.map((item) => item.text).join("")))] : [];
  return !(maxCharacters !== undefined && texts.some((text) => text.length > maxCharacters)) &&
    !(block.type === "list" && capacity.maxItems !== undefined && block.items.length > capacity.maxItems) &&
    !(block.type === "table" && capacity.maxRows !== undefined && block.rows.length > capacity.maxRows);
}

function provenanceFor(evidence: FixedEvidence): Provenance[] {
  switch (evidence.kind) {
    case "source": return evidence.chunks.flatMap((chunk) => chunk.locators.map((locator) => ({ kind: "source", sourceVersionId: chunk.sourceVersionId, locator })));
    case "fact": return [{ kind: "fact", factVersionId: evidence.entity.factVersionId }];
    case "user_assertion": return [{ kind: "user_assertion", messageId: evidence.messageId }];
    case "media": return evidence.occurrence === null ? [] : [{ kind: "source", sourceVersionId: evidence.occurrence.sourceVersionId, locator: evidence.occurrence.locator }];
    default: { const exhaustive: never = evidence; return exhaustive; }
  }
}

function deduplicateProvenance(items: Provenance[]): Provenance[] {
  return [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
}

function claimsFor(block: Block, part: Exclude<BodyPart, { kind: "image" }>, evidence: FixedEvidence[]): Claim[] {
  const text = part.kind === "paragraph" ? part.text : part.kind === "list" ? part.items.join("\n")
    : [part.columns.join("\t"), ...part.rows.map((row) => row.join("\t"))].join("\n");
  const textHash = createHash("sha256").update(text).digest("hex");
  const claims: Claim[] = [];
  const interpreted: string[] = [];
  for (const fixed of evidence) {
    if (fixed.kind === "user_assertion") {
      if (fixed.exactText !== text || fixed.textHash !== textHash) invalid("用户陈述只能逐字引用，不能将改写标为原陈述");
      claims.push({ kind: "user_assertion", nodeId: block.id, textHash, evidenceId: fixed.evidenceId });
    } else if (fixed.kind === "source" || fixed.kind === "fact") {
      interpreted.push(fixed.evidenceId);
    }
  }
  if (interpreted.length > 0) claims.push({ kind: "source_interpretation", nodeId: block.id, textHash, evidenceIds: interpreted, review: "requires_human" });
  return claims;
}

function stableNodeId(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return NodeIdSchema.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}
