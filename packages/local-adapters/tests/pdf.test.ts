import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdf } from "../src/index.js";
import { makePdf, makeStaging, writeFixture } from "./fixtures.js";

describe("PDF local extraction", () => {
  it("extracts page text with pdfjs and real page images when pdftoppm exists", async () => {
    const staging = await makeStaging("pdf-text");
    const sourcePath = join(staging, "sample.pdf");
    await writeFixture(sourcePath, await makePdf(["Page one title", "Page two title"]));
    const result = await extractPdf({ sourcePath, stagingDir: staging });

    expect(result.format).toBe("pdf");
    expect(result.pageCount).toBe(2);
    expect(result.sections.map((section) => section.order)).toEqual([1, 2]);
    expect(result.sections[0]?.blocks[0]?.text).toContain("Page one");
    expect(result.sections[1]?.blocks[0]?.text).toContain("Page two");
    expect(result.warnings.some((warning) => warning.code === "OCR_BLOCKED")).toBe(true);

    if (result.capabilities.renderer === "pdftoppm") {
      expect(result.media).toHaveLength(2);
      expect(result.occurrences.map((occurrence) => occurrence.locator)).toEqual([
        { kind: "page", page: 1 },
        { kind: "page", page: 2 },
      ]);
      for (const resource of result.media) {
        expect(resource.status).toBe("extracted");
        if (resource.status !== "extracted") continue;
        expect(resource.mime).toBe("image/png");
        expect((await stat(join(staging, resource.stagedPath))).size).toBe(resource.bytes);
      }
      expect(result.status).toBe("complete");
    } else {
      expect(result.media).toHaveLength(0);
      expect(result.status).toBe("partial");
      expect(result.warnings.some((warning) => warning.code === "PAGE_RENDER_UNAVAILABLE")).toBe(true);
    }
  });

  it("reports disabled page rendering as partial without fabricating page images", async () => {
    const staging = await makeStaging("pdf-disabled");
    const sourcePath = join(staging, "sample.pdf");
    await writeFixture(sourcePath, await makePdf(["Only text"]));
    const result = await extractPdf({
      sourcePath,
      stagingDir: staging,
      options: { renderPdfPages: false },
    });
    expect(result.media).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.capabilities.pageImages).toBe("disabled");
    expect(result.warnings.some((warning) => warning.code === "PAGE_RENDER_UNAVAILABLE")).toBe(true);
  });

  it("rejects over-limit input and already-aborted calls", async () => {
    const staging = await makeStaging("pdf-limits");
    const sourcePath = join(staging, "sample.pdf");
    await writeFixture(sourcePath, await makePdf(["Text"]));

    await expect(
      extractPdf({ sourcePath, stagingDir: staging, options: { limits: { maxInputBytes: 20 } } }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      extractPdf({ sourcePath, stagingDir: staging, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
