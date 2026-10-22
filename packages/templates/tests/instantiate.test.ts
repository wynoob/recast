import { describe, expect, it } from "vitest";
import { validateAst } from "@dmall/domain";
import {
  TemplatePackageSchema,
  buildBuiltinTemplatePackage,
  builtinNarratives,
  createSyntheticSample,
  instantiateTemplate,
  reviseTemplatePackage,
} from "../src/index.js";
import { stableUuid } from "../src/ids.js";

describe("template instantiation", () => {
  it("instantiates valid ASTs for six narratives and two formats", () => {
    for (const narrative of builtinNarratives) {
      for (const kind of ["feishu_doc", "html_deck"] as const) {
        const sample = createSyntheticSample(narrative.id, kind);
        const validation = validateAst(sample.instance.ast);
        expect(
          validation.ok,
          `${narrative.id}/${kind}: ${validation.ok ? "" : JSON.stringify(validation.violations)}`,
        ).toBe(true);
        expect(sample.instance.unplacedBlocks).toEqual([]);
        expect(sample.instance.templateSnapshot.manifest.templateVersionId).toBe(
          sample.packageValue.manifest.templateVersionId,
        );
        if (kind === "feishu_doc") {
          expect(sample.instance.ast.kind).toBe("feishu_doc");
          if (sample.instance.ast.kind === "feishu_doc") {
            expect(sample.instance.ast.sections).toHaveLength(
              narrative.doc.sections.length,
            );
          }
        } else {
          expect(sample.instance.ast.kind).toBe("html_deck");
          if (sample.instance.ast.kind === "html_deck") {
            expect(sample.instance.ast.slides).toHaveLength(narrative.deck.slides.length);
            expect(
              new Set(sample.instance.ast.slides.map((slide) => slide.layout)).size,
            ).toBe(8);
          }
        }
      }
    }
  });

  it("omits empty optional media and never fabricates an image", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    const result = instantiateTemplate({
      templatePackage: sample.packageValue,
      brief: sample.brief,
      targetKind: "html_deck",
      materials: [],
      facts: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.unplacedBlocks).toEqual([]);
    expect(
      result.instance.slotTrace.some(
        (trace) =>
          trace.slotId === "detail-media" &&
          trace.status === "omitted",
      ),
    ).toBe(true);
    if (result.instance.ast.kind === "html_deck") {
      const imageCount = result.instance.ast.slides
        .flatMap((slide) => slide.blocks)
        .filter((block) => block.type === "image").length;
      expect(imageCount).toBe(0);
    }
    expect(result.warnings.some((warning) => warning.includes("可选媒体未提供"))).toBe(true);
  });

  it("fails closed for unknown, out-of-scope and mismatched references", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    const baseInput = {
      templatePackage: sample.packageValue,
      brief: sample.brief,
      targetKind: "html_deck",
      materials: sample.materials,
      facts: sample.facts,
      slotBindings: sample.slotBindings,
    };
    const unknownMaterial = instantiateTemplate({
      ...baseInput,
      slotBindings: {
        ...sample.slotBindings,
        "detail-media": {
          kind: "material",
          materialId: stableUuid("missing-material"),
        },
      },
    });
    expect(unknownMaterial.ok).toBe(false);
    if (!unknownMaterial.ok) {
      expect(unknownMaterial.issues.map((item) => item.code)).toContain(
        "UNKNOWN_MATERIAL_REF",
      );
    }

    const outOfScopeBrief = {
      ...sample.brief,
      sourceScope: { sourceVersionIds: [], excludeIds: [] },
    };
    const outOfScope = instantiateTemplate({
      ...baseInput,
      brief: outOfScopeBrief,
    });
    expect(outOfScope.ok).toBe(false);
    if (!outOfScope.ok) {
      expect(outOfScope.issues.map((item) => item.code)).toContain(
        "SOURCE_OUT_OF_SCOPE",
      );
    }

    const unknownFact = instantiateTemplate({
      ...baseInput,
      slotBindings: {
        ...sample.slotBindings,
        "detail-body": {
          kind: "fact",
          factVersionId: stableUuid("missing-fact"),
        },
      },
    });
    expect(unknownFact.ok).toBe(false);
    if (!unknownFact.ok) {
      expect(unknownFact.issues.map((item) => item.code)).toContain(
        "UNKNOWN_FACT_REF",
      );
    }

    const merchantMismatchFact = {
      ...sample.facts[0]!,
      merchantId: stableUuid("other-merchant"),
    };
    const merchantMismatch = instantiateTemplate({
      ...baseInput,
      facts: [merchantMismatchFact],
    });
    expect(merchantMismatch.ok).toBe(false);
    if (!merchantMismatch.ok) {
      expect(merchantMismatch.issues.map((item) => item.code)).toContain(
        "FACT_MERCHANT_MISMATCH",
      );
    }
  });

  it("fails closed when a required slot has no source and when capacity is exceeded", () => {
    const sample = createSyntheticSample("product-intro", "feishu_doc");
    const requiredMedia = structuredClone(sample.packageValue);
    const evidenceSlot = requiredMedia.slots.find(
      (slot) => slot.id === "problem-evidence",
    );
    expect(evidenceSlot).toBeDefined();
    if (evidenceSlot !== undefined) evidenceSlot.required = true;
    const missing = instantiateTemplate({
      templatePackage: TemplatePackageSchema.parse(requiredMedia),
      brief: sample.brief,
      targetKind: "feishu_doc",
      materials: [],
      facts: [],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.map((item) => item.code)).toContain(
        "REQUIRED_MATERIAL_MISSING",
      );
    }

    const oversized = instantiateTemplate({
      templatePackage: sample.packageValue,
      brief: sample.brief,
      targetKind: "feishu_doc",
      materials: sample.materials,
      facts: sample.facts,
      slotBindings: {
        ...sample.slotBindings,
        "problem-body": {
          kind: "text",
          text: "超".repeat(501),
        },
      },
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.issues.map((item) => item.code)).toContain(
        "SLOT_CAPACITY_EXCEEDED",
      );
    }
  });

  it("rejects an output-kind mismatch", () => {
    const sample = createSyntheticSample("training", "feishu_doc");
    const deck = buildBuiltinTemplatePackage("training", "html_deck");
    const result = instantiateTemplate({
      templatePackage: deck,
      brief: sample.brief,
      targetKind: "feishu_doc",
      materials: sample.materials,
      facts: sample.facts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain(
        "TARGET_KIND_MISMATCH",
      );
    }
  });

  it("fails closed when the user outline exceeds the controlled deck slots", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    const tooMany = {
      ...sample.brief,
      mustKeepOutline: true,
      userOutline: Array.from({ length: sample.packageValue.narrative.deck.slides.length + 1 }, (_, index) => ({
        id: stableUuid(`too-many:${index}`),
        title: `章节 ${index + 1}`,
      })),
    };
    const result = instantiateTemplate({
      templatePackage: sample.packageValue,
      brief: tooMany,
      targetKind: "html_deck",
      materials: sample.materials,
      facts: sample.facts,
      slotBindings: sample.slotBindings,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain(
        "OUTLINE_EXCEEDS_DECK_CAPACITY",
      );
    }
  });

  it("creates a new draft version without mutating an old instance snapshot", () => {
    const sample = createSyntheticSample("phase-review", "feishu_doc");
    const readyPackage = TemplatePackageSchema.parse({
      ...sample.packageValue,
      manifest: {
        ...sample.packageValue.manifest,
        status: "ready",
      },
    });
    const nextVersionId = stableUuid("phase-review:version:2");
    const draft = reviseTemplatePackage({
      templatePackage: readyPackage,
      templateVersionId: nextVersionId,
      changeSummary: "调整提示词和容量",
      now: "2026-10-21T08:00:00.000Z",
    });
    expect(draft.manifest.status).toBe("draft");
    expect(draft.manifest.version).toBe(readyPackage.manifest.version + 1);
    expect(draft.manifest.previousVersionId).toBe(
      readyPackage.manifest.templateVersionId,
    );
    expect(draft.manifest.templateVersionId).toBe(nextVersionId);
    expect(sample.instance.templateSnapshot.manifest.status).toBe("draft");
    expect(sample.instance.templateSnapshot.manifest.templateVersionId).toBe(
      sample.packageValue.manifest.templateVersionId,
    );
    expect(sample.instance.ast.title).toContain("合成示意");
  });
});
