import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NodeIdSchema, type Block } from "@dmall/contracts";
import { createSyntheticSample, instantiateTemplate, TemplatePackageSchema, instanceToDeckDraft, collectUnplacedBlocks, validateExportReadiness, renderTemplateSample, validateTemplatePackage, builtinNarratives, type TemplateInstance } from "../src/index.js";
import { stableUuid } from "../src/ids.js";
function canonical(v: unknown): string {
  if (Array.isArray(v))
    return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function blocks(i: TemplateInstance): Block[] { return i.ast.kind === "feishu_doc" ? i.ast.sections.flatMap(s => s.blocks) : i.ast.slides.flatMap(s => s.blocks); }
function base() { const s = createSyntheticSample("product-intro", "feishu_doc"); return { templatePackage: s.packageValue, brief: s.brief, targetKind: "feishu_doc" as const, materials: s.materials, facts: s.facts, slotBindings: s.slotBindings }; }
function evidence(i: TemplateInstance, media: Record<string, string>) { const r = renderTemplateSample({ instance: i, media }); return { source: "chromium", rendererVersion: i.templateSnapshot.rendererVersion, sampleHash: r.artifactHash, ...(i.slotTrace.some(t => t.status === "placed" && "containerNodeId" in t) ? { templateHash: hash(i.templateSnapshot), astHash: hash(i.ast) } : {}), loaded: true, missingResources: [], externalRequests: [], overflow: { screen: false, print: false }, print: { pages: 1, pdfBytes: 100, pdfSha256: "b".repeat(64) }, contrast: { textOnBackground: 10, mutedOnBackground: 8, accentTextOnAccent: 6, minimum: 6 }, checkedAt: "2026-10-21T08:00:00.000Z" }; }
function ready(i: TemplateInstance, media: Record<string, string>, pkg = i.templateSnapshot) { return validateTemplatePackage(pkg, { mode: "ready", instance: i, sample: { ast: i.ast, media }, evidence: evidence(i, media) }); }
describe("T05 accepted parent defects", () => {
  it("F1 rejects unsupported fact-to-divider equally through both selections", () => {
    const input = base();
    const slot = input.templatePackage.slots[0]!;
    const fact = input.facts[0]!;
    slot.blockType = "divider";
    slot.source = { kind: "fact" };
    const automatic = instantiateTemplate({ ...input, facts: [fact], slotBindings: {} });
    const explicit = instantiateTemplate({ ...input, facts: [fact], slotBindings: { [slot.id]: { kind: "fact", factVersionId: fact.factVersionId } } });
    expect(automatic.ok).toBe(false);
    expect(explicit.ok).toBe(false);
    if (automatic.ok || explicit.ok)
      throw new Error("unsupported fact selection admitted");
    expect(automatic.issues.map(item => item.code)).toEqual(explicit.issues.map(item => item.code));
  });
  for (const type of ["paragraph", "callout", "list", "table"] as const)
    it(`F1 same fact produces ${type} through either selection`, () => {
      const input = base();
      const slot = input.templatePackage.slots[0]!;
      slot.blockType = type;
      slot.source = { kind: "fact" };
      slot.capacity = { maxCharacters: 500, maxItems: 5, maxRows: 5 };
      const fact = input.facts[0]!;
      const a = instantiateTemplate({ ...input, facts: [fact], slotBindings: {} });
      const b = instantiateTemplate({ ...input, facts: [fact], slotBindings: { [slot.id]: { kind: "fact", factVersionId: fact.factVersionId } } });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok)
        throw Error("fact selection failed");
      expect(blocks(a.instance)[0]).toEqual(blocks(b.instance)[0]);
      expect(blocks(a.instance)[0]?.type).toBe(type);
    });
  it("F1 rejects unknown binding keys", () => {
    const r = instantiateTemplate({ ...base(), slotBindings: { "typo-body": { kind: "text", text: "must not disappear" } } });
    expect(r.ok).toBe(false);
    if (r.ok)
      throw Error("unknown binding accepted");
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "UNKNOWN_SLOT_BINDING", path: expect.stringContaining("typo-body") }));
  });
  for (const target of ["doc", "deck", "layouts", "layout-slots"] as const)
    it(`F1 rejects duplicate ${target} IDs`, () => {
      const pkg = createSyntheticSample("product-intro", target === "doc" ? "feishu_doc" : "html_deck").packageValue;
      if (target === "doc")
        pkg.narrative.doc.sections.push(structuredClone(pkg.narrative.doc.sections[0]!));
      if (target === "deck")
        pkg.narrative.deck.slides.push(structuredClone(pkg.narrative.deck.slides[0]!));
      if (target === "layouts")
        pkg.layouts.push(structuredClone(pkg.layouts[0]!));
      if (target === "layout-slots")
        pkg.layouts[0]!.slots.push(structuredClone(pkg.layouts[0]!.slots[0]!));
      expect(TemplatePackageSchema.safeParse(pkg).success).toBe(false);
    });
  it("F1 rejects duplicate outline IDs via canonical AST validation", () => {
    const input = base();
    input.brief.userOutline[1]!.id = input.brief.userOutline[0]!.id;
    const r = instantiateTemplate(input);
    expect(r.ok).toBe(false);
    if (r.ok)
      throw Error("duplicate AST admitted");
    expect(r.issues.some(i => i.code === "DUPLICATE_NODE_ID")).toBe(true);
  });
  it("F2 preserves block multiset and blocked state", () => {
    const s = createSyntheticSample("product-intro", "html_deck");
    const i = structuredClone(s.instance);
    if (i.ast.kind !== "html_deck")
      throw Error("fixture kind");
    const slide = i.ast.slides.find(s => s.layout === "title-body-media")!;
    const moved = slide.blocks.pop()!;
    i.unplacedBlocks = [moved];
    const draft = instanceToDeckDraft(i, { [moved.id]: slide.id });
    if (draft.ast.kind !== "html_deck")
      throw Error("draft kind");
    expect(draft.ast.slides.flatMap(s => s.blocks).map(b => b.id).sort()).toEqual([...blocks(i), moved].map(b => b.id).sort());
    expect(collectUnplacedBlocks(draft)).toEqual([expect.objectContaining({ id: moved.id, slotId: null })]);
    expect(validateExportReadiness({ draft }).ok).toBe(false);
  });
  it("F2 refuses unowned unplaced blocks", () => { const s = createSyntheticSample("product-intro", "html_deck"); const moved = structuredClone(blocks(s.instance)[0]!); moved.id = NodeIdSchema.parse(stableUuid("unowned")); s.instance.unplacedBlocks = [moved]; expect(() => instanceToDeckDraft(s.instance)).toThrow(/UNPLACED_OWNER/); });
  it("F3 resolves two derivatives of one asset without original fallback", () => {
    const s = createSyntheticSample("product-intro", "feishu_doc");
    const images = blocks(s.instance).filter(b => b.type === "image");
    const a = images[0]!, b = images[1]!;
    b.assetVersionId = a.assetVersionId;
    b.derivativeId = stableUuid("second-crop");
    const media: Record<string, string> = { ...s.mediaPaths, [`asset_version:${a.assetVersionId}`]: "assets/original.svg", [`derivative:${a.derivativeId}`]: "assets/masked.svg", [`derivative:${b.derivativeId}`]: "assets/cropped.svg" };
    const r = renderTemplateSample({ instance: s.instance, media });
    expect(r.ok).toBe(true);
    expect(r.resourcePaths).toContain("assets/masked.svg");
    expect(r.resourcePaths).toContain("assets/cropped.svg");
    expect(r.resourcePaths).not.toContain("assets/original.svg");
    expect(r.html).toContain('src="assets/masked.svg"');
    expect(r.html).toContain('src="assets/cropped.svg"');
    delete media[`derivative:${a.derivativeId}`];
    const missing = renderTemplateSample({ instance: s.instance, media });
    expect(missing.ok).toBe(false);
    expect(missing.resourcePaths).not.toContain("assets/original.svg");
  });
  it("F4 positive evidence shape control", () => { const s = createSyntheticSample("product-intro", "feishu_doc"); expect(ready(s.instance, s.mediaPaths).ok).toBe(true); });
  it("F4 rejects same version ID with changed whole package", () => { const s = createSyntheticSample("product-intro", "feishu_doc"); const pkg = structuredClone(s.packageValue); pkg.manifest.name = "changed package"; pkg.theme.typography.body = "ui-serif"; const r = ready(s.instance, s.mediaPaths, pkg); expect(r.ok).toBe(false); expect(r.issues.some(i => i.code === "SAMPLE_TEMPLATE_SNAPSHOT_MISMATCH")).toBe(true); });
  for (const defect of ["delete", "type", "capacity", "trace-target", "trace-duplicate", "trace-container"] as const)
    it(`F4 rejects stale trace ${defect}`, () => {
      const s = createSyntheticSample("product-intro", "feishu_doc");
      const i = s.instance;
      if (i.ast.kind !== "feishu_doc")
        throw Error("fixture kind");
      const section = i.ast.sections[0]!, block = section.blocks[0];
      if (block?.type !== "paragraph")
        throw Error("fixture body");
      if (defect === "delete")
        section.blocks.shift();
      if (defect === "type")
        section.blocks[0] = { ...block, type: "callout" };
      if (defect === "capacity")
        block.inlines = [{ text: "x".repeat(501), marks: [] }];
      if (defect === "trace-target") {
        const trace = i.slotTrace[0]!;
        if (trace.status !== "placed")
          throw Error("fixture trace");
        trace.blockId = stableUuid("absent");
      }
      if (defect === "trace-duplicate")
        i.slotTrace.push(structuredClone(i.slotTrace[0]!));
      if (defect === "trace-container") {
        section.blocks.shift();
        i.ast.sections[1]!.blocks.push(block);
      }
      const r = ready(i, s.mediaPaths);
      expect(r.ok).toBe(false);
      expect(r.issues.some(x => x.code.startsWith("INSTANCE_SLOT_") || x.code === "REQUIRED_SLOT_NOT_PLACED")).toBe(true);
    });
  it("F4 binds current AST even if HTML unchanged", () => { const s = createSyntheticSample("product-intro", "feishu_doc"); const old = evidence(s.instance, s.mediaPaths); s.instance.ast.locks = ["reviewed-lock"]; const r = validateTemplatePackage(s.packageValue, { mode: "ready", instance: s.instance, sample: { ast: s.instance.ast, media: s.mediaPaths }, evidence: old }); expect(r.ok).toBe(false); expect(r.issues.some(i => i.code === "RENDER_EVIDENCE_AST_HASH_MISMATCH")).toBe(true); });
  it("F5 retains all narrative sections in order and both formats", () => {
    for (const n of builtinNarratives) {
      const titles = n.doc.sections.map(s => s.title);
      let at = -1;
      for (const title of titles) {
        at = n.deck.slides.findIndex((s, index) => index > at && s.title === title);
        expect(at, `${n.id}/${title}`).toBeGreaterThanOrEqual(0);
      }
      for (const kind of ["feishu_doc", "html_deck"] as const) {
        const s = createSyntheticSample(n.id, kind);
        const actual = s.instance.ast.kind === "feishu_doc" ? s.instance.ast.sections.map(x => x.title) : s.instance.ast.slides.map(x => x.title);
        for (const title of titles)
          expect(actual).toContain(title);
      }
    }
  });
});
