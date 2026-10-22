import { describe, expect, it } from "vitest";
import {
  BriefSchema,
  NodeIdSchema,
  ReadyRenderEvidenceSchema,
  TemplateInstanceSchema,
  TemplatePackageSchema,
  buildBuiltinTemplatePackage,
  createSyntheticSample,
  instantiateTemplate,
  instanceToDeckDraft,
  assessTemplateReadiness,
} from "../src/index.js";
import { stableUuid } from "../src/ids.js";

const MERCHANT_ID = stableUuid("contracts-v2:merchant");

describe("T05 shared Brief and strict contracts", () => {
  it("preserves null duration, 2.5 minutes and duplicate questions", () => {
    const brief = BriefSchema.parse({
      schemaVersion: 1,
      contentId: stableUuid("contracts-v2:content"),
      goal: "保留业务输入",
      audience: ["评审"],
      merchantId: MERCHANT_ID,
      durationMinutes: 2.5,
      userOutline: [],
      mustKeepOutline: false,
      tone: "直接",
      sourceScope: { sourceVersionIds: [], excludeIds: [] },
      unresolvedQuestions: ["是否包含门店？", "是否包含门店？"],
      targetKind: "feishu_doc",
    });
    expect(brief.durationMinutes).toBe(2.5);
    expect(brief.unresolvedQuestions).toEqual(["是否包含门店？", "是否包含门店？"]);
    expect(brief.userOutline).toEqual([]);
    expect(brief.audience).toEqual(["评审"]);
    expect(brief.tone).toBe("直接");
    expect(brief.merchantId).toBe(MERCHANT_ID);
    expect(brief.sourceScope).toEqual({ sourceVersionIds: [], excludeIds: [] });

    const nullBrief = BriefSchema.parse({ ...brief, durationMinutes: null });
    expect(nullBrief.durationMinutes).toBeNull();
  });

  it("reports duration and unresolved questions without rewriting the Brief", () => {
    const sample = createSyntheticSample("product-intro", "feishu_doc");
    const pkg = structuredClone(sample.packageValue);
    const firstSection = pkg.narrative.doc.sections[0];
    if (firstSection === undefined) throw new Error("fixture section missing");
    pkg.slots.push({
      id: `${firstSection.id}-duration`,
      containerId: firstSection.id,
      order: 2,
      label: "讲解时长",
      blockType: "paragraph",
      required: false,
      capacity: { maxCharacters: 20 },
      source: { kind: "brief", field: "durationMinutes" },
    });
    pkg.slots.push({
      id: `${firstSection.id}-goal`,
      containerId: firstSection.id,
      order: 3,
      label: "目标摘要",
      blockType: "paragraph",
      required: false,
      capacity: { maxCharacters: 80 },
      source: { kind: "brief", field: "goal" },
    });
    pkg.slots.push({
      id: `${firstSection.id}-tone`,
      containerId: firstSection.id,
      order: 4,
      label: "语气提示",
      blockType: "paragraph",
      required: false,
      capacity: { maxCharacters: 40 },
      source: { kind: "brief", field: "tone" },
    });
    const parsed = TemplatePackageSchema.parse(pkg);
    const brief = BriefSchema.parse({
      ...sample.brief,
      goal: " ",
      tone: "",
      durationMinutes: null,
      unresolvedQuestions: ["重复问题", "重复问题"],
    });
    const before = structuredClone(brief);
    const readiness = assessTemplateReadiness({ templatePackage: parsed, brief });
    expect(readiness.kind).toBe("waiting_input");
    if (readiness.kind === "waiting_input") {
      expect(readiness.issues.map((item) => item.kind)).toContain("duration_required");
      expect(readiness.issues.map((item) => item.kind)).toContain("goal_required");
      expect(readiness.issues.map((item) => item.kind)).toContain("tone_required");
      expect(readiness.unresolvedQuestions).toEqual([
        { index: 0, originalText: "重复问题" },
        { index: 1, originalText: "重复问题" },
      ]);
    }
    expect(brief).toEqual(before);
  });

  it("reports the goal required by a title source without changing the Brief", () => {
    const sample = createSyntheticSample("internal-sharing", "feishu_doc");
    const pkg = structuredClone(sample.packageValue);
    const slot = pkg.slots.find((item) => item.blockType === "paragraph");
    if (slot === undefined) throw new Error("fixture paragraph missing");
    slot.required = true;
    slot.source = { kind: "brief", field: "title" };
    const brief = { ...sample.brief, goal: " ", unresolvedQuestions: [] };
    const before = structuredClone(brief);
    const readiness = assessTemplateReadiness({ templatePackage: pkg, brief });
    expect(readiness).toMatchObject({
      kind: "waiting_input",
      issues: [{ kind: "goal_required", path: "brief.goal" }],
      unresolvedQuestions: [],
    });
    const instantiate = (goal: string) => instantiateTemplate({
      templatePackage: pkg,
      brief: { ...brief, goal },
      targetKind: "feishu_doc",
      materials: sample.materials,
      facts: sample.facts,
    });
    const missing = instantiate(brief.goal);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.some((issue) => issue.code === "BRIEF_INPUT_REQUIRED")).toBe(true);
    const goal = " 保留标题来源原文 ";
    expect(assessTemplateReadiness({ templatePackage: pkg, brief: { ...brief, goal } })).toEqual({ kind: "ready" });
    const filled = instantiate(goal);
    expect(filled.ok).toBe(true);
    if (filled.ok && filled.instance.ast.kind === "feishu_doc") {
      expect(JSON.stringify(filled.instance.ast)).toContain(goal);
    }
    expect(brief).toEqual(before);
  });

  it("uses explicit targetKind instead of Brief.targetKind", () => {
    const sample = createSyntheticSample("product-intro", "feishu_doc");
    const deckSample = createSyntheticSample("product-intro", "html_deck");
    const deck = buildBuiltinTemplatePackage("product-intro", "html_deck");
    const input = {
      templatePackage: deck,
      brief: sample.brief,
      targetKind: "html_deck" as const,
      materials: deckSample.materials,
      facts: deckSample.facts,
      slotBindings: deckSample.slotBindings,
    };
    const before = structuredClone(sample.brief);
    const result = instantiateTemplate(input);
    expect(result.ok).toBe(true);
    expect(input.brief).toEqual(before);
    expect(input.brief.targetKind).toBe("feishu_doc");
    if (result.ok) expect(result.instance.ast.kind).toBe("html_deck");
  });

  it("rejects legacy slot traces and old ready evidence without hashes", () => {
    const sample = createSyntheticSample("product-intro", "feishu_doc");
    const legacyTrace = structuredClone(sample.instance) as unknown as {
      slotTrace: Array<Record<string, unknown>>;
    };
    const placed = legacyTrace.slotTrace.find((trace) => trace.status === "placed");
    if (placed === undefined) throw new Error("fixture trace missing");
    delete placed.containerNodeId;
    expect(TemplateInstanceSchema.safeParse(legacyTrace).success).toBe(false);

    expect(ReadyRenderEvidenceSchema.safeParse({
      source: "chromium",
      rendererVersion: "docx-1",
      sampleHash: "a".repeat(64),
      loaded: true,
      missingResources: [],
      externalRequests: [],
      overflow: { screen: false, print: false },
      print: { pages: 1, pdfBytes: 100, pdfSha256: "b".repeat(64) },
      contrast: {
        textOnBackground: 10,
        mutedOnBackground: 8,
        accentTextOnAccent: 6,
        minimum: 6,
      },
      checkedAt: "2026-10-21T08:00:00.000Z",
    }).success).toBe(false);
  });

  it("keeps unplaced blocks in Deck AST with slotId null and refuses guessed owners", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    const instance = structuredClone(sample.instance);
    if (instance.ast.kind !== "html_deck") throw new Error("fixture deck missing");
    const slide = instance.ast.slides.find((item) => item.layout === "title-body-media");
    if (slide === undefined) throw new Error("fixture slide missing");
    const moved = slide.blocks.pop();
    if (moved === undefined) throw new Error("fixture block missing");
    instance.unplacedBlocks = [moved];

    const draft = instanceToDeckDraft(instance);
    if (draft.ast.kind !== "html_deck") throw new Error("draft deck missing");
    const owned = draft.ast.slides.find((item) => item.id === slide.id)?.blocks.find((block) => block.id === moved.id);
    expect(owned?.slotId).toBeNull();

    const unowned = structuredClone(instance);
    const orphan = structuredClone(moved);
    orphan.id = NodeIdSchema.parse(stableUuid("unowned-contracts-v2"));
    unowned.unplacedBlocks = [orphan];
    expect(() => instanceToDeckDraft(unowned)).toThrow(/UNPLACED_OWNER_REQUIRED/);
  });
});
