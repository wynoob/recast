import { describe, expect, it } from "vitest";
import {
  DeckDraftSchema,
  changeDeckSlideLayout,
  collectUnplacedBlocks,
  createSyntheticSample,
  instanceToDeckDraft,
  placeUnplacedBlock,
  validateExportReadiness,
} from "../src/index.js";

describe("deck layout changes", () => {
  it("keeps removed blocks and user edits instead of dropping or overwriting them", () => {
    const sample = createSyntheticSample("product-intro", "html_deck");
    const initial = instanceToDeckDraft(sample.instance);
    if (initial.ast.kind !== "html_deck") throw new Error("样例不是演示 AST");
    const detail = initial.ast.slides.find((slide) => slide.layout === "title-body-media");
    expect(detail).toBeDefined();
    if (detail === undefined) return;
    const paragraph = detail.blocks.find((block) => block.type === "paragraph");
    const image = detail.blocks.find((block) => block.type === "image");
    expect(paragraph).toBeDefined();
    expect(image).toBeDefined();
    if (paragraph === undefined || image === undefined) return;

    const edited = DeckDraftSchema.parse({
      ...initial,
      ast: {
        ...initial.ast,
        slides: initial.ast.slides.map((slide) =>
          slide.id !== detail.id
            ? slide
            : {
                ...slide,
                blocks: slide.blocks.map((block) =>
                  block.id !== paragraph.id || block.type !== "paragraph"
                    ? block
                    : {
                        ...block,
                        inlines: block.inlines.map((inline, index) =>
                          index === 0
                            ? { ...inline, text: "用户手改：这段内容不能被切版式覆盖。" }
                            : inline,
                        ),
                      },
                ),
              },
        ),
      },
    });

    const switched = changeDeckSlideLayout({
      draft: edited,
      slideId: detail.id,
      layoutId: "two-column",
    });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.movedToUnplaced).toEqual(
      expect.arrayContaining([paragraph.id, image.id]),
    );
    if (switched.draft.ast.kind !== "html_deck") throw new Error("样例不是演示 AST");
    const unplaced = switched.draft.ast.slides.find(slide => slide.id === detail.id)?.blocks.filter(block => block.slotId === null) ?? [];
    const preserved = unplaced.find((block) => block.id === paragraph.id);
    expect(preserved).toBeDefined();
    expect(preserved?.type).toBe("paragraph");
    if (preserved?.type === "paragraph") {
      expect(preserved.inlines[0]?.text).toBe(
        "用户手改：这段内容不能被切版式覆盖。",
      );
    }

    const readiness = validateExportReadiness({ draft: switched.draft });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.issues.map((item) => item.code)).toContain(
        "UNPLACED_BLOCK",
      );
    }
  });

  it("requires explicit placement after switching back and blocks export until complete", () => {
    const sample = createSyntheticSample("training", "html_deck");
    const initial = instanceToDeckDraft(sample.instance);
    if (initial.ast.kind !== "html_deck") throw new Error("样例不是演示 AST");
    const detail = initial.ast.slides.find((slide) => slide.layout === "title-body-media");
    expect(detail).toBeDefined();
    if (detail === undefined) return;
    const paragraph = detail.blocks.find((block) => block.type === "paragraph");
    const image = detail.blocks.find((block) => block.type === "image");
    if (paragraph === undefined || image === undefined) return;

    const switched = changeDeckSlideLayout({
      draft: initial,
      slideId: detail.id,
      layoutId: "metric-evidence",
    });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(collectUnplacedBlocks(switched.draft)).toHaveLength(2);

    const back = changeDeckSlideLayout({
      draft: switched.draft,
      slideId: detail.id,
      layoutId: "title-body-media",
    });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(collectUnplacedBlocks(back.draft)).toHaveLength(2);
    expect(
      back.draft.ast.kind === "html_deck"
        ? back.draft.ast.slides.find((slide) => slide.id === detail.id)?.blocks.every(block => block.slotId === null)
        : undefined,
    ).toBe(true);

    const placedParagraph = placeUnplacedBlock({
      draft: back.draft,
      slideId: detail.id,
      blockId: paragraph.id,
      layoutSlotId: "body",
    });
    expect(placedParagraph.ok).toBe(true);
    if (!placedParagraph.ok) return;
    const afterParagraph = validateExportReadiness({
      draft: placedParagraph.draft,
    });
    expect(afterParagraph.ok).toBe(false);

    const placedImage = placeUnplacedBlock({
      draft: placedParagraph.draft,
      slideId: detail.id,
      blockId: image.id,
      layoutSlotId: "media",
    });
    expect(placedImage.ok).toBe(true);
    if (!placedImage.ok) return;
    expect(collectUnplacedBlocks(placedImage.draft)).toEqual([]);
    expect(validateExportReadiness({ draft: placedImage.draft }).ok).toBe(true);
  });

  it("rejects incompatible explicit placement", () => {
    const sample = createSyntheticSample("executive-progress", "html_deck");
    const draft = instanceToDeckDraft(sample.instance);
    if (draft.ast.kind !== "html_deck") throw new Error("样例不是演示 AST");
    const detail = draft.ast.slides.find((slide) => slide.layout === "title-body-media");
    if (detail === undefined) return;
    const image = detail.blocks.find((block) => block.type === "image");
    if (image === undefined) return;
    const moved = changeDeckSlideLayout({
      draft,
      slideId: detail.id,
      layoutId: "two-column",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const rejected = placeUnplacedBlock({
      draft: moved.draft,
      slideId: detail.id,
      blockId: image.id,
      layoutSlotId: "left",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.issues.map((item) => item.code)).toContain(
        "SLOT_INCOMPATIBLE",
      );
    }
  });
});
