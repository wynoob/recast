import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AstSchema,
  ClaimSchema,
  FixedEvidenceSchema,
  TemplatePackageSchema,
  type FixedEvidence,
  type TemplatePackage,
} from "@dmall/contracts";
import { applyEditOperations, validateAst } from "@dmall/domain";
import { buildBuiltinTemplatePackage, canonicalHash } from "@dmall/templates";
import { compileCompositionDraft } from "../../apps/server/src/authoring/composition-draft.js";
import { templateAstValid } from "../../apps/server/src/authoring/template-check.js";
import { ApiError } from "../../apps/server/src/errors.js";

type Input = Parameters<typeof compileCompositionDraft>[0];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function evidence(): FixedEvidence[] {
  const sourceVersionId = randomUUID();
  const occurrenceId = randomUUID();
  const locator = { kind: "block", blockId: "source-image" };
  return [
    FixedEvidenceSchema.parse({ kind: "user_assertion", evidenceId: randomUUID(), selectionHandle: null,
      messageId: randomUUID(), contentId: randomUUID(), exactText: "门店每周核对一次库存。", textHash: hash("门店每周核对一次库存。") }),
    FixedEvidenceSchema.parse({ kind: "source", evidenceId: randomUUID(), selectionHandle: `sel1:${randomUUID()}`,
      indexGenerationId: randomUUID(), refType: "chunk", refId: randomUUID(), sourceVersionId, occurrence: null,
      exactText: "先检查库存，再补货。", entityHash: hash("source"), indexTextHash: hash("source"),
      chunks: [{ chunkId: randomUUID(), refType: "chunk", refId: randomUUID(), sourceVersionId, occurrenceId: null,
        blockIds: [], locators: [locator], fullText: "先检查库存，再补货。",
        indexText: { text: "先检查库存，再补货。", codePoints: 10, textHash: hash("先检查库存，再补货。") } }] }),
    FixedEvidenceSchema.parse({ kind: "media", evidenceId: randomUUID(), selectionHandle: null,
      assetVersionId: randomUUID(), assetId: randomUUID(), mediaKind: "image", blobHash: hash("image"),
      derivative: { id: randomUUID(), blobHash: hash("crop"), recipeHash: hash("recipe") }, segment: null, poster: null,
      occurrence: { requestedOccurrenceId: occurrenceId, canonicalOccurrenceId: occurrenceId, observedVersion: 1,
        sourceVersionId, locator, assetIdAtCapture: null, relationHash: hash("binding") } }),
  ];
}

function fixture(kind: "feishu_doc" | "html_deck"): Input {
  const fixed = evidence();
  const assertion = fixed[0]!;
  const source = fixed[1]!;
  const image = fixed[2]!;
  const pkg = buildBuiltinTemplatePackage("training", kind);
  pkg.manifest.status = "ready";
  pkg.narrative.doc.sections = ["first", "second"].map((id) => ({ id, title: id, purpose: "写作指导不作正文", requiredEvidence: [] }));
  pkg.narrative.deck.slides = ["first", "second"].map((id) => ({ id, title: id, purpose: "写作指导不作正文", layout: "title-body-media" }));
  const slotKinds = ["paragraph", "list", "table", "image"] as const;
  const slotSources = {
    paragraph: { kind: "default", value: { kind: "text", text: "模板默认说明不能填入正文" } },
    list: { kind: "default", value: { kind: "list", items: ["模板默认说明"] } },
    table: { kind: "default", value: { kind: "table", columns: ["模板默认说明"], rows: [["模板默认说明"]] } },
    image: { kind: "material", mediaKind: "image" },
  } satisfies Record<typeof slotKinds[number], TemplatePackage["slots"][number]["source"]>;
  pkg.slots = ["first", "second"].flatMap((containerId) => slotKinds.map((blockType, order) => ({
    id: `${containerId}-${blockType}`, containerId, order, blockType, label: blockType,
    required: containerId === "first" || blockType === "paragraph", capacity: { maxCharacters: 80, maxItems: 3, maxRows: 3 },
    source: slotSources[blockType],
    ...(kind === "html_deck" ? { layoutSlotId: blockType } : {}),
  })));
  pkg.layouts = kind === "html_deck" ? [{ id: "title-body-media", name: "正文与图片", description: "验证用受控版式",
    canvas: { width: 1600, height: 900 }, titleMaxCharacters: 30,
    slots: slotKinds.map((blockType) => ({ id: blockType, label: blockType, blockTypes: [blockType],
      required: blockType === "paragraph", maxCharacters: 100, maxItems: 4, maxRows: 4 })) }] : [];
  const templatePackage = TemplatePackageSchema.parse(pkg);
  const common = {
    id: randomUUID(), contentId: randomUUID(), basedOnVersion: 1, hash: hash("proposal"), title: "门店库存操作方案",
    purpose: "减少重复核对", audience: "店长",
    template: { versionId: pkg.manifest.templateVersionId, packageHash: canonicalHash(templatePackage), reason: "步骤清晰" },
    evidence: fixed.map((item) => ({ id: item.evidenceId, kind: item.kind, title: item.kind, sourceLabel: item.kind, merchantId: null, availability: "available" as const })),
    gaps: [],
  };
  const parts: Extract<Input["body"], { kind: "feishu_doc" }>["sections"][number]["parts"] = [
    { key: "statement", kind: "paragraph", text: "门店每周核对一次库存。", sources: [assertion.evidenceId] },
    { key: "steps", kind: "list", items: ["检查库存", "按缺口补货"], sources: [source.evidenceId] },
    { key: "table", kind: "table", columns: ["动作", "负责人"], rows: [["核对", "店长"]], sources: [] },
    { key: "photo", kind: "image", evidenceId: image.evidenceId, caption: "库存核对界面" },
  ];
  const placement = { evidenceId: image.evidenceId, purpose: "展示界面", position: "正文后", use: "illustration" as const };
  const baseline = { schemaVersion: 1, title: "", locks: [] };
  const shared = { templatePackage, evidence: fixed, rootNodeId: randomUUID(), generationInputId: randomUUID() };
  if (kind === "feishu_doc") {
    return { ...shared, baseAst: AstSchema.parse({ ...baseline, kind, sections: [], speakerNotes: {} }),
      proposal: { ...common, delivery: { kind, folderToken: null },
        sections: ["first", "second"].map((key) => ({ key, heading: key, intent: "正文", templateContainerKey: key, placements: key === "first" ? [placement] : [] })) },
      body: { kind, title: common.title, sections: [
        { key: "first", heading: "first", parts },
        { key: "second", heading: "second", parts: [{ key: "next", kind: "paragraph", text: "下周复核执行结果。", sources: [] }] },
      ] } };
  }
  return { ...shared, baseAst: AstSchema.parse({ ...baseline, kind, slides: [], canvas: { width: 1600, height: 900 } }),
    proposal: { ...common, delivery: { kind }, slides: ["first", "second"].map((key) => ({ key, title: key, intent: "正文",
      templateContainerKey: key, layoutKey: "title-body-media", placements: key === "first" ? [{ ...placement, templateSlotKey: "first-image" }] : [] })) },
    body: { kind, title: common.title, slides: [
      { key: "first", title: "first", speakerNotes: "向店长说明核对顺序。", templateContainerKey: "first", layoutKey: "title-body-media",
        parts: parts.map((part) => ({ ...part, templateSlotKey: `first-${part.kind}` })) },
      { key: "second", title: "second", speakerNotes: "安排复核。", templateContainerKey: "second", layoutKey: "title-body-media",
        parts: [{ key: "next", kind: "paragraph", text: "下周复核执行结果。", sources: [], templateSlotKey: "second-paragraph" }] },
    ] } };
}

function apply(input: Input) {
  const compiled = compileCompositionDraft(input);
  const result = applyEditOperations({ ast: input.baseAst, operations: compiled.operations, rules: { rootNodeId: input.rootNodeId, actor: "ai" } });
  if (!result.ok) throw new Error(JSON.stringify(result.violations));
  return { ...compiled, ast: result.ast };
}

function updatePackage(input: Input, change: (pkg: TemplatePackage) => void) {
  change(input.templatePackage);
  input.proposal.template.packageHash = canonicalHash(input.templatePackage);
}

describe("confirmed composition draft compilation", () => {
  it.each(["feishu_doc", "html_deck"] as const)("builds a complete %s with fixed media and truthful provenance", (kind) => {
    const input = fixture(kind);
    const { ast, claims } = apply(input);
    expect(validateAst(ast).ok).toBe(true);
    expect(templateAstValid(input.templatePackage, ast)).toBe(true);
    expect(ast.title).toBe(input.proposal.title);
    const units = ast.kind === "feishu_doc" ? ast.sections : ast.slides;
    expect(units.map((unit) => unit.title)).toEqual(["first", "second"]);
    expect(units[0]!.blocks.map((block) => block.type)).toEqual(["paragraph", "list", "table", "image"]);
    const image = input.evidence[2]!;
    if (image.kind !== "media") throw new Error("expected media");
    expect(units[0]!.blocks[3]).toMatchObject({ assetVersionId: image.assetVersionId, derivativeId: image.derivative?.id,
      occurrenceId: image.occurrence?.requestedOccurrenceId, provenance: [{ kind: "source", sourceVersionId: image.occurrence?.sourceVersionId, locator: image.occurrence?.locator }] });
    expect(claims.map((claim) => ClaimSchema.parse(claim).kind)).toEqual(["user_assertion", "source_interpretation"]);
    expect(claims[0]).toMatchObject({ textHash: hash("门店每周核对一次库存。") });
    expect(claims[1]).toMatchObject({ evidenceIds: [input.evidence[1]!.evidenceId], review: "requires_human" });
    if (ast.kind === "feishu_doc") expect(units.flatMap((unit) => unit.blocks).every((block) => block.slotId === undefined)).toBe(true);
    else {
      expect(ast.canvas).toEqual({ width: 1600, height: 900 });
      expect(ast.slides[0]!.speakerNotes).toBe("向店长说明核对顺序。");
      expect(ast.slides.flatMap((slide) => slide.blocks).every((block) => typeof block.slotId === "string")).toBe(true);
    }
    expect(JSON.stringify(ast)).not.toContain("模板默认说明");
  });

  it.each(["feishu_doc", "html_deck"] as const)("replays %s deterministically and changes IDs for a new generation", (kind) => {
    const input = fixture(kind);
    const first = compileCompositionDraft(input);
    expect(compileCompositionDraft(structuredClone(input))).toEqual(first);
    expect(compileCompositionDraft({ ...input, generationInputId: randomUUID() })).not.toEqual(first);
  });

  it("rejects unknown or unavailable references and paraphrased user assertions", () => {
    const input = fixture("feishu_doc");
    if (input.body.kind !== "feishu_doc") throw new Error("expected doc");
    const part = input.body.sections[0]!.parts[0]!;
    if (part.kind !== "paragraph") throw new Error("expected paragraph");
    part.sources = [randomUUID()];
    expect(() => compileCompositionDraft(input)).toThrowError(expect.objectContaining({ code: "UNKNOWN_REFERENCE" }));
    part.sources = [input.evidence[0]!.evidenceId];
    input.proposal.evidence[0]!.availability = "missing";
    expect(() => compileCompositionDraft(input)).toThrowError(expect.objectContaining({ code: "UNKNOWN_REFERENCE" }));
    input.proposal.evidence[0]!.availability = "available";
    part.text = "已经核实门店每天核对库存。";
    expect(() => compileCompositionDraft(input)).toThrowError(expect.objectContaining({ code: "DRAFT_INVALID" }));
  });

  it("rejects wrong document order, heading, duplicate keys and table row width", () => {
    const input = fixture("feishu_doc");
    if (input.body.kind !== "feishu_doc") throw new Error("expected doc");
    input.body.sections.reverse();
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
    input.body.sections.reverse();
    input.body.sections[0]!.heading = "未确认标题";
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
    input.body.sections[0]!.heading = "first";
    const parts = input.body.sections[0]!.parts;
    parts[1]!.key = parts[0]!.key;
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
    parts[1]!.key = "steps";
    const table = parts[2]!;
    if (table.kind !== "table") throw new Error("expected table");
    table.rows = [["列数错误"]];
    expect(() => compileCompositionDraft(input)).toThrowError(/列数/);
  });

  it("requires confirmed images, their exact slide slots and available media", () => {
    const input = fixture("html_deck");
    if (input.body.kind !== "html_deck") throw new Error("expected deck");
    const parts = input.body.slides[0]!.parts;
    const image = parts.pop()!;
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
    parts.push({ ...image, templateSlotKey: "second-image" });
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
    parts[3] = image;
    const fixed = input.evidence[2]!;
    if (fixed.kind !== "media") throw new Error("expected media");
    fixed.occurrence = null;
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
  });

  it.each(["template", "layout"])("enforces %s capacity without truncating text", (layer) => {
    const input = fixture("html_deck");
    updatePackage(input, (pkg) => {
      if (layer === "template") pkg.slots[0]!.capacity.maxCharacters = 2;
      else pkg.layouts[0]!.slots[0]!.maxCharacters = 2;
    });
    expect(() => compileCompositionDraft(input)).toThrowError(/容量/);
  });

  it("enforces layout block counts, list items, table rows and required coverage", () => {
    const input = fixture("html_deck");
    if (input.body.kind !== "html_deck") throw new Error("expected deck");
    const slide = input.body.slides[0]!;
    const paragraph = slide.parts[0]!;
    slide.parts.push({ ...paragraph, key: "another" });
    updatePackage(input, (pkg) => { pkg.layouts[0]!.slots[0]!.maxItems = 1; });
    expect(() => compileCompositionDraft(input)).toThrowError(/块数/);
    slide.parts.pop();
    updatePackage(input, (pkg) => { pkg.slots[1]!.capacity.maxItems = 1; });
    expect(() => compileCompositionDraft(input)).toThrowError(/容量/);
    updatePackage(input, (pkg) => { pkg.slots[1]!.capacity.maxItems = 3; pkg.slots[2]!.capacity.maxRows = 1; });
    const table = slide.parts[2]!;
    if (table.kind !== "table") throw new Error("expected table");
    table.rows.push(["补货", "值班员"]);
    expect(() => compileCompositionDraft(input)).toThrowError(/容量/);
    table.rows.pop();
    slide.parts.splice(1, 1);
    expect(() => compileCompositionDraft(input)).toThrowError(/必填/);
  });

  it("rejects changed layouts, long titles and nonempty baselines", () => {
    const input = fixture("html_deck");
    if (input.body.kind !== "html_deck") throw new Error("expected deck");
    input.body.slides[0]!.layoutKey = "closing";
    expect(() => compileCompositionDraft(input)).toThrow(ApiError);
    input.body.slides[0]!.layoutKey = "title-body-media";
    updatePackage(input, (pkg) => { pkg.layouts[0]!.titleMaxCharacters = 2; });
    expect(() => compileCompositionDraft(input)).toThrowError(/标题容量/);
    updatePackage(input, (pkg) => { pkg.layouts[0]!.titleMaxCharacters = 30; });
    input.baseAst = apply(input).ast;
    expect(() => compileCompositionDraft(input)).toThrowError(/空稿/);
  });
});
