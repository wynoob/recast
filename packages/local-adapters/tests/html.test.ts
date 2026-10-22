import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { extractStaticHtml } from "../src/index.js";
import { ONE_PIXEL_PNG, makeStaging, writeFixture } from "./fixtures.js";

describe("static HTML extraction", () => {
  it("extracts headings, paragraphs, local media, missing locations and dynamic warning", async () => {
    const staging = await makeStaging("html-mixed");
    await mkdir(join(staging, "assets"), { recursive: true });
    await writeFixture(join(staging, "assets", "pixel.png"), ONE_PIXEL_PNG);
    await writeFixture(join(staging, "outside.png"), ONE_PIXEL_PNG);
    const html = `<!doctype html><html><head><title>合成报告</title>
      <script>window.bad = "SCRIPT_TEXT_MUST_NOT_APPEAR";</script>
    </head><body>
      <h1>第一章</h1>
      <p>第一段</p><p>图前文字</p>
      <img src="assets/pixel.png" alt="像素">
      <p>图后文字</p><p>末尾文字</p>
      <h2>子章</h2>
      <p>第二段</p>
      <img src="assets/missing.png">
      <img src="https://example.invalid/remote.png">
      <img src="../outside.png">
      <img src="file:///etc/passwd">
      <button onclick="alert('never')">静态按钮</button>
    </body></html>`;
    const sourcePath = join(staging, "report.html");
    await writeFile(sourcePath, html, "utf8");
    const result = await extractStaticHtml({ sourcePath, stagingDir: staging });

    expect(result.sections.map((section) => section.title)).toEqual(["第一章", "子章"]);
    expect(result.sections[0]?.blocks.map((block) => block.text)).toEqual([
      "第一段",
      "图前文字",
      "图后文字",
      "末尾文字",
    ]);
    expect(JSON.stringify(result)).not.toContain("SCRIPT_TEXT_MUST_NOT_APPEAR");
    expect(JSON.stringify(result)).not.toContain("alert('never')");
    expect(result.status).toBe("partial");
    expect(result.warnings.some((warning) => warning.code === "DYNAMIC_HTML_NEEDS_ADAPTER")).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "MISSING_DEPENDENCY")).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "EXTERNAL_LINK_BLOCKED")).toBe(true);

    const extracted = result.media.find(
      (resource) => resource.status === "extracted" && resource.sourceInternalPath === "assets/pixel.png",
    );
    expect(extracted?.status).toBe("extracted");
    const missing = result.media.find(
      (resource) => resource.status === "missing" && resource.sourceInternalPath === "assets/missing.png",
    );
    expect(missing).toMatchObject({ status: "missing", errorCode: "MISSING_DEPENDENCY" });
    const external = result.media.find(
      (resource) =>
        resource.status === "missing" && resource.sourceInternalPath === "https://example.invalid/remote.png",
    );
    expect(external).toMatchObject({ status: "missing", errorCode: "EXTERNAL_LINK_BLOCKED" });
    const traversal = result.media.find(
      (resource) => resource.status === "missing" && resource.sourceInternalPath.includes("../outside.png"),
    );
    expect(traversal).toMatchObject({ status: "missing", errorCode: "PATH_NOT_ALLOWED" });
    const fileUri = result.media.find(
      (resource) => resource.status === "missing" && resource.sourceInternalPath.startsWith("file:"),
    );
    expect(fileUri).toMatchObject({ status: "missing", errorCode: "PATH_NOT_ALLOWED" });

    const pixelOccurrence = result.occurrences.find(
      (occurrence) => occurrence.mediaId === extracted?.id,
    );
    expect(pixelOccurrence?.beforeText).toContain("图前文字");
    expect(pixelOccurrence?.afterText).toContain("图后文字");
    for (const occurrence of result.occurrences) {
      expect(occurrence.beforeText.length).toBeLessThanOrEqual(1_000);
      expect(occurrence.afterText.length).toBeLessThanOrEqual(1_000);
    }
  });

  it("returns complete for a local static page with no missing dependency", async () => {
    const staging = await makeStaging("html-complete");
    await writeFixture(join(staging, "pixel.png"), ONE_PIXEL_PNG);
    const sourcePath = join(staging, "index.html");
    await writeFile(
      sourcePath,
      `<html><head><title>静态页</title></head><body><h1>标题</h1><p>正文</p><img src="pixel.png"></body></html>`,
      "utf8",
    );
    const result = await extractStaticHtml({ sourcePath, stagingDir: staging });
    expect(result.status).toBe("complete");
    expect(result.media).toHaveLength(1);
    expect(result.occurrences).toHaveLength(1);
    expect(result.sections[0]?.title).toBe("标题");
  });

  it("does not follow a dependency symlink outside the HTML root", async () => {
    const staging = await makeStaging("html-symlink");
    const outside = await mkdtemp(join(tmpdir(), "dcw-html-outside-"));
    try {
      await writeFile(join(outside, "secret.png"), ONE_PIXEL_PNG);
      await mkdir(join(staging, "assets"), { recursive: true });
      await symlink(join(outside, "secret.png"), join(staging, "assets", "link.png"));
      const sourcePath = join(staging, "index.html");
      await writeFile(
        sourcePath,
        `<html><body><h1>标题</h1><p>正文</p><img src="assets/link.png"></body></html>`,
        "utf8",
      );
      const result = await extractStaticHtml({ sourcePath, stagingDir: staging });
      expect(result.media[0]).toMatchObject({
        status: "missing",
        errorCode: "PATH_NOT_ALLOWED",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
