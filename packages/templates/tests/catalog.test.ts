import { describe, expect, it } from "vitest";
import {
  TemplatePackageSchema,
  buildBuiltinTemplatePackage,
  builtinNarratives,
  layoutSampleIds,
  registeredLayouts,
} from "../src/index.js";

const EXPECTED_NARRATIVES = [
  "product-intro",
  "executive-progress",
  "phase-review",
  "merchant-solution",
  "internal-sharing",
  "training",
];

const EXPECTED_SECTIONS: Record<string, string[]> = {
  "product-intro": ["经营问题", "产品定位", "场景演示", "价值与边界", "下一步"],
  "executive-progress": ["本期结论", "使用与价值证据", "客户案例", "风险", "下期计划"],
  "phase-review": ["目标", "交付", "采用情况", "证据", "差距", "行动"],
  "merchant-solution": ["商家现状", "场景目标", "方案", "演示", "实施与验收"],
  "internal-sharing": ["问题", "机制", "实例", "经验", "讨论"],
  training: ["入口", "基础提问", "连续任务", "注意事项", "练习"],
};

describe("template catalog", () => {
  it("registers the six fixed narratives with both output mappings", () => {
    expect(builtinNarratives.map((item) => item.id)).toEqual(EXPECTED_NARRATIVES);
    for (const narrative of builtinNarratives) {
      expect(narrative.doc.sections.map((item) => item.title)).toEqual(
        EXPECTED_SECTIONS[narrative.id],
      );
      const narrativeTitles = narrative.doc.sections.map(item => item.title);
      expect(narrative.deck.slides.filter(slide => narrativeTitles.includes(slide.title)).map(slide => slide.title)).toEqual(narrativeTitles);
      expect(new Set(narrative.deck.slides.map((slide) => slide.layout))).toEqual(
        new Set(layoutSampleIds()),
      );
    }
  });

  it("registers all eight layouts on a 1600 by 900 canvas", () => {
    expect(registeredLayouts.map((layout) => layout.id)).toEqual(layoutSampleIds());
    for (const layout of registeredLayouts) {
      expect(layout.canvas).toEqual({ width: 1600, height: 900 });
      expect(layout.titleMaxCharacters).toBeLessThanOrEqual(28);
      expect(layout.slots.length).toBeGreaterThan(0);
    }
  });

  it("builds strict document and deck packages for all narratives", () => {
    for (const narrative of builtinNarratives) {
      const doc = buildBuiltinTemplatePackage(narrative.id, "feishu_doc");
      const deck = buildBuiltinTemplatePackage(narrative.id, "html_deck");
      expect(doc.rendererVersion).toBe("docx-1");
      expect(deck.rendererVersion).toBe("deck-1");
      expect(doc.manifest.kind).toBe("feishu_doc");
      expect(deck.manifest.kind).toBe("html_deck");
      expect(doc.layouts).toEqual([]);
      expect(deck.layouts).toHaveLength(8);
      expect(TemplatePackageSchema.safeParse(doc).success).toBe(true);
      expect(TemplatePackageSchema.safeParse(deck).success).toBe(true);
      expect(doc.slots.length).toBeGreaterThan(0);
      expect(deck.slots.length).toBeGreaterThan(0);
      expect(doc.manifest.customerSpecificDefaults).toBe(false);
      expect(deck.manifest.customerSpecificDefaults).toBe(false);
    }
  });

  it("rejects unknown execution fields, raw HTML and arbitrary CSS", () => {
    const base = buildBuiltinTemplatePackage("product-intro", "feishu_doc");
    const withScriptField = { ...base, script: "alert(1)" };
    expect(TemplatePackageSchema.safeParse(withScriptField).success).toBe(false);

    const withCss = {
      ...base,
      theme: { ...base.theme, css: "body{display:none}" },
    };
    expect(TemplatePackageSchema.safeParse(withCss).success).toBe(false);

    const withScriptText = structuredClone(base);
    withScriptText.slots[0]!.source = {
      kind: "default",
      value: { kind: "text", text: "<script>alert(1)</script>" },
    };
    expect(TemplatePackageSchema.safeParse(withScriptText).success).toBe(false);

    const withImport = structuredClone(base);
    withImport.slots[0]!.label = "@import url(https://example.com/font.css)";
    expect(TemplatePackageSchema.safeParse(withImport).success).toBe(false);
  });

  it("rejects unknown layouts and capacity overflow in a template package", () => {
    const base = buildBuiltinTemplatePackage("product-intro", "html_deck");
    const unknownLayout = {
      ...base,
      narrative: {
        ...base.narrative,
        deck: {
          slides: base.narrative.deck.slides.map((slide, index) =>
            index === 0 ? { ...slide, layout: "free-canvas" } : slide,
          ),
        },
      },
    };
    expect(TemplatePackageSchema.safeParse(unknownLayout).success).toBe(false);

    const oversized = structuredClone(base);
    const bodySlot = oversized.slots.find((slot) => slot.id === "detail-body");
    expect(bodySlot).toBeDefined();
    if (bodySlot !== undefined) {
      bodySlot.capacity.maxCharacters = 999;
    }
    expect(TemplatePackageSchema.safeParse(oversized).success).toBe(false);
  });
});
