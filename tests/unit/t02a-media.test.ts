import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTags, sniffMagic } from "@dmall/domain";
import { parseMarkdown } from "../../apps/worker/src/markdown.js";

describe("T02a magic classification", () => {
  it("uses magic bytes rather than extension", () => {
    expect(sniffMagic(Buffer.from("89504e470d0a1a0a00000000", "hex"), "x.bin", null)).toMatchObject({
      kind: "image",
      mime: "image/png",
      extensionMismatch: true,
    });
    expect(sniffMagic(Buffer.from("ffd8ffe000104a464946", "hex"), "x.jpg", null)).toMatchObject({
      kind: "image",
      mime: "image/jpeg",
    });
    expect(sniffMagic(Buffer.from("RIFF1234WEBPVP8 ", "binary"), "x.webp", null)).toMatchObject({
      kind: "image",
      mime: "image/webp",
    });
    expect(sniffMagic(Buffer.from("GIF89a0000", "binary"), "x.gif", null)).toMatchObject({
      kind: "gif",
      mime: "image/gif",
    });
    const mp4 = Buffer.alloc(32);
    mp4.writeUInt32BE(24, 0);
    mp4.write("ftyp", 4, "ascii");
    mp4.write("isom", 8, "ascii");
    expect(sniffMagic(mp4, "x.mp4", null)).toMatchObject({
      kind: "video",
      mime: "video/mp4",
    });
    expect(sniffMagic(Buffer.from("# 标题\n"), "x.md", "# 标题\n")).toMatchObject({
      kind: "markdown",
      mime: "text/markdown",
    });
    expect(sniffMagic(Buffer.from("MZ not media"), "x.exe", null).kind).toBe("unsupported");
  });
});

describe("T02a markdown parser", () => {
  it("keeps bounded same-section context and explicit missing/external states", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcw-md-"));
    await mkdir(join(root, "images"));
    await writeFile(join(root, "images", "one.png"), Buffer.from("not decoded here"));
    const markdown = [
      "# 第一章",
      "",
      "前置一。",
      "",
      "前置二。",
      "",
      "![行内](images/one.png)",
      "",
      "后置一。",
      "",
      "后置二。",
      "",
      "![引用][pic]",
      "",
      '<img src="./missing.png">',
      "",
      "![外链](https://example.com/a.png)",
      "",
      "[pic]: ./images/one.png",
      "",
      "# 第二章",
      "",
      "另一章。",
    ].join("\n");
    const occurrences = await parseMarkdown({
      text: markdown,
      rootPath: root,
      relativePath: "docs/readme.md",
    });
    expect(occurrences).toHaveLength(4);
    expect(occurrences[0]?.locator).toMatchObject({
      kind: "markdown",
      line: 7,
      normalizedRelativePath: "docs/images/one.png",
    });
    expect(occurrences[0]?.headingPath).toBe("第一章");
    expect(occurrences[0]?.beforeText).toContain("前置二");
    expect(occurrences[0]?.beforeText).not.toContain("![");
    expect(occurrences[0]?.afterText).toContain("后置二");
    expect(occurrences[0]?.afterText).not.toContain("第二章");
    expect(occurrences[2]?.mediaStatus).toBe("missing");
    expect(occurrences[2]?.errorCode).toBe("MISSING_DEPENDENCY");
    expect(occurrences[3]?.locator).toMatchObject({ resolution: "external_url" });
    expect(occurrences[3]?.mediaStatus).toBe("unsupported");
    expect(JSON.stringify(occurrences)).not.toContain("blockId");
  });
});

describe("T02a tag normalization", () => {
  it("normalizes case-insensitively and removes duplicates", () => {
    expect(normalizeTags(["  品牌 ", "品牌", "Logo"])).toEqual({
      display: ["品牌", "Logo"],
      keys: ["品牌", "logo"],
    });
  });
});
