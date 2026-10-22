import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPptx } from "../src/index.js";
import { S06_PATH, S08_PATH, makeStaging } from "./fixtures.js";

describe("PPTX local extraction", () => {
  it("extracts both real decks in presentation order with all media and page relations", async () => {
    const staging06 = await makeStaging("pptx-s06");
    const staging08 = await makeStaging("pptx-s08");
    const s06 = await extractPptx({ sourcePath: S06_PATH, stagingDir: staging06 });
    const s08 = await extractPptx({ sourcePath: S08_PATH, stagingDir: staging08 });

    expect(s06.format).toBe("pptx");
    expect(s06.pageCount).toBe(34);
    expect(s06.sections.map((section) => section.order)).toEqual(
      Array.from({ length: 34 }, (_, index) => index + 1),
    );
    expect(s06.media).toHaveLength(35);
    expect(s06.status).toBe("partial");
    expect(s06.originalSha256).toBe(
      "8e92e45ef109f6b2155acb0cef83c3b7ab560d400078b1d50c874035e58c5da2",
    );
    expect(s06.warnings.some((warning) => warning.code === "LIBREOFFICE_UNAVAILABLE")).toBe(true);

    expect(s08.pageCount).toBe(12);
    expect(s08.sections.map((section) => section.order)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(s08.media).toHaveLength(12);
    expect(s08.status).toBe("partial");
    expect(s08.originalSha256).toBe(
      "e0b47909655f8daaeb25621c6959458e506657ede9e3e88611c700f1a7220462",
    );
    expect(s08.sections[0]?.blocks.length).toBeGreaterThan(0);

    for (const [documentResult, staging] of [
      [s06, staging06],
      [s08, staging08],
    ] as const) {
      for (const resource of documentResult.media) {
        if (resource.status !== "extracted") continue;
        expect(resource.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(resource.bytes).toBeGreaterThan(0);
        expect(resource.mime.length).toBeGreaterThan(0);
        expect(resource.sourceInternalPath.startsWith("ppt/media/")).toBe(true);
        expect((await stat(join(staging, resource.stagedPath))).size).toBe(resource.bytes);
      }
      expect(documentResult.media.every((resource) => resource.status === "extracted")).toBe(true);
    }

    const mp4 = s06.media.find(
      (resource) =>
        resource.status === "extracted" && resource.sourceInternalPath === "ppt/media/media1.mp4",
    );
    expect(mp4).toBeDefined();
    const mp4Occurrence = s06.occurrences.find((occurrence) => occurrence.mediaId === mp4?.id);
    expect(mp4Occurrence?.locator).toEqual({ kind: "page", page: 11 });

    const image8 = s08.media.find(
      (resource) =>
        resource.status === "extracted" && resource.sourceInternalPath === "ppt/media/image8.png",
    );
    expect(image8).toBeDefined();
    const image8Pages = s08.occurrences
      .filter((occurrence) => occurrence.mediaId === image8?.id)
      .map((occurrence) => occurrence.locator.kind === "page" ? occurrence.locator.page : -1);
    expect(image8Pages).toEqual([8, 9, 10, 11, 12]);

    expect((await stat(S06_PATH)).size).toBe(51_676_334);
  });
});
