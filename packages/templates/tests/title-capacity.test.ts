import { describe, expect, it } from "vitest";
import {
  createSyntheticSample,
  instantiateTemplate,
  instanceToDeckDraft,
  registeredLayouts,
  validateExportReadiness,
} from "../src/index.js";

describe("actual AST title capacity", () => {
  for (const layout of registeredLayouts) {
    for (const extra of [0, 1]) {
      it(`${layout.id} allows ${layout.titleMaxCharacters} and refuses one extra code unit (${extra})`, () => {
        const sample = createSyntheticSample("product-intro", "html_deck");
        const ast = sample.instance.ast;
        if (ast.kind !== "html_deck") throw Error("deck fixture required");
        const slideIndex = ast.slides.findIndex(slide => slide.layout === layout.id);
        const slide = ast.slides[slideIndex];
        if (slide === undefined) throw Error(`missing fixture layout ${layout.id}`);
        slide.title = "题".repeat(layout.titleMaxCharacters + extra);
        const original = structuredClone(sample.instance);
        const instantiated = instantiateTemplate({
          templatePackage: sample.packageValue,
          brief: {
            ...sample.brief,
            mustKeepOutline: true,
            userOutline: ast.slides.map(item => ({ id: item.id, title: item.title })),
          },
          targetKind: "html_deck",
          materials: sample.materials,
          facts: sample.facts,
          slotBindings: sample.slotBindings,
        });
        expect(instantiated.ok).toBe(extra === 0);
        if (!instantiated.ok) {
          expect(instantiated.issues).toContainEqual(expect.objectContaining({
            code: "TITLE_CAPACITY_EXCEEDED",
            path: `deck.slides[${slideIndex}].title`,
          }));
        }
        for (const input of [
          { instance: sample.instance },
          { draft: instanceToDeckDraft(sample.instance) },
        ]) {
          const readiness = validateExportReadiness(input);
          expect(readiness.ok).toBe(extra === 0);
          if (!readiness.ok) {
            expect(readiness.issues).toEqual([{
              code: "TITLE_CAPACITY_EXCEEDED",
              path: `ast.slides[${slideIndex}].title`,
              message: `标题 ${slide.title.length} 字，超过 ${layout.titleMaxCharacters} 字`,
            }]);
          }
        }
        expect(sample.instance).toEqual(original);
      });
    }
  }

  it("retains string.length semantics for supplementary characters", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    if (sample.instance.ast.kind !== "html_deck") throw Error("deck fixture required");
    const slide = sample.instance.ast.slides[0];
    if (slide === undefined) throw Error("cover required");
    for (const [title, ok] of [["😀".repeat(14), true], ["😀".repeat(14) + "题", false]] as const) {
      slide.title = title;
      const instantiated = instantiateTemplate({
        templatePackage: sample.packageValue,
        brief: { ...sample.brief, mustKeepOutline: true, userOutline: [{ id: slide.id, title }] },
        targetKind: "html_deck",
        materials: sample.materials,
        facts: sample.facts,
        slotBindings: sample.slotBindings,
      });
      expect(instantiated.ok).toBe(ok);
      expect(validateExportReadiness({ instance: sample.instance }).ok).toBe(ok);
    }
  });

  it("uses the pinned layout capacity instead of a global title limit", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    if (sample.instance.ast.kind !== "html_deck") throw Error("deck fixture required");
    const slide = sample.instance.ast.slides[0];
    const layout = sample.instance.templateSnapshot.layouts.find(item => item.id === slide?.layout);
    if (slide === undefined || layout === undefined) throw Error("cover required");
    layout.titleMaxCharacters = 12;
    slide.title = "题".repeat(12);
    expect(validateExportReadiness({ instance: sample.instance }).ok).toBe(true);
    slide.title += "题";
    const result = validateExportReadiness({ instance: sample.instance });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map(item => item.code)).toEqual(["TITLE_CAPACITY_EXCEEDED"]);
  });

  it("keeps document titles outside deck layout capacity", () => {
    const sample = createSyntheticSample("product-intro", "feishu_doc");
    if (sample.instance.ast.kind !== "feishu_doc") throw Error("doc fixture required");
    const section = sample.instance.ast.sections[0];
    if (section === undefined) throw Error("section required");
    section.title = "题".repeat(29);
    sample.instance.ast.title = "题".repeat(29);
    expect(validateExportReadiness({ instance: sample.instance }).ok).toBe(true);
  });
});
