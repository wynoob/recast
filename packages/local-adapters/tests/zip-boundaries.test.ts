import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPptx } from "../src/index.js";
import {
  duplicateNameZip,
  expansionZip,
  makeStaging,
  maliciousZip,
  minimalPptx,
  twoSlidePptx,
  writeFixture,
} from "./fixtures.js";

describe("ZIP boundary handling", () => {
  it("extracts a minimal PPTX with text, notes and page-linked media", async () => {
    const staging = await makeStaging("zip-minimal");
    const sourcePath = join(staging, "minimal.pptx");
    await writeFixture(sourcePath, minimalPptx());
    const result = await extractPptx({ sourcePath, stagingDir: staging });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.blocks.map((block) => block.text)).toEqual(["标题 A", "正文 B"]);
    expect(result.sections[0]?.notes).toContain("讲解备注");
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.status).toBe("extracted");
    expect(result.occurrences[0]?.locator).toEqual({ kind: "page", page: 1 });
  });

  it("uses presentation relationships and sldIdLst order, not file-name sorting", async () => {
    const staging = await makeStaging("zip-slide-order");
    const sourcePath = join(staging, "ordered.pptx");
    await writeFixture(sourcePath, twoSlidePptx());
    const result = await extractPptx({ sourcePath, stagingDir: staging });
    expect(result.sections.map((section) => section.title)).toEqual(["File two", "File one"]);
    expect(result.sections.map((section) => section.blocks[0]?.text)).toEqual(["File two", "File one"]);
  });

  it("blocks path traversal and duplicate entry names", async () => {
    const traversalStaging = await makeStaging("zip-traversal");
    const traversalPath = join(traversalStaging, "traversal.pptx");
    await writeFixture(traversalPath, maliciousZip("../evil.xml"));
    await expect(
      extractPptx({ sourcePath: traversalPath, stagingDir: traversalStaging }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });

    const duplicateStaging = await makeStaging("zip-duplicate");
    const duplicatePath = join(duplicateStaging, "duplicate.pptx");
    await writeFixture(duplicatePath, await duplicateNameZip("dup.txt"));
    await expect(
      extractPptx({ sourcePath: duplicatePath, stagingDir: duplicateStaging }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("enforces entry, expanded size and expansion ratio limits", async () => {
    const entryStaging = await makeStaging("zip-entry-limit");
    const entryPath = join(entryStaging, "minimal.pptx");
    await writeFixture(entryPath, minimalPptx());
    await expect(
      extractPptx({
        sourcePath: entryPath,
        stagingDir: entryStaging,
        options: { limits: { maxArchiveEntries: 2 } },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });

    const sizeStaging = await makeStaging("zip-size-limit");
    const sizePath = join(sizeStaging, "minimal.pptx");
    await writeFixture(sizePath, minimalPptx());
    await expect(
      extractPptx({
        sourcePath: sizePath,
        stagingDir: sizeStaging,
        options: { limits: { maxExpandedBytes: 100 } },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });

    const ratioStaging = await makeStaging("zip-ratio-limit");
    const ratioPath = join(ratioStaging, "bomb.pptx");
    await writeFixture(ratioPath, expansionZip(1_000_000));
    await expect(
      extractPptx({
        sourcePath: ratioPath,
        stagingDir: ratioStaging,
        options: { limits: { maxExpansionRatio: 2 } },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("does not follow external PPTX media links", async () => {
    const staging = await makeStaging("zip-external");
    const sourcePath = join(staging, "external.pptx");
    await writeFixture(sourcePath, minimalPptx({ externalImage: true }));
    const result = await extractPptx({ sourcePath, stagingDir: staging });
    const external = result.media.find(
      (resource) =>
        resource.status === "missing" &&
        resource.sourceInternalPath === "https://example.invalid/blocked.png",
    );
    expect(external).toMatchObject({ status: "missing", errorCode: "EXTERNAL_LINK_BLOCKED" });
    expect(result.warnings.some((warning) => warning.code === "EXTERNAL_LINK_BLOCKED")).toBe(true);
  });
});
