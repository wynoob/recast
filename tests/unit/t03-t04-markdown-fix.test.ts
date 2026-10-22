import { describe, expect, it } from "vitest";
import { markdownHeadings, scanMarkdownLines } from "@dmall/domain";
import { parseMarkdownDocument } from "../../apps/worker/src/markdown.js";

const parse = (text: string) => parseMarkdownDocument({
  text, rootPath: "/unused", relativePath: "guide.md", knownFiles: ["real.png", "wrong.png"],
});

describe("shared physical Markdown structure", () => {
  it.each([
    ["````md", "```", "`````\t"],
    ["~~~~md", "~~~", "~~~~ "],
    ["```md", "~~~", "```"],
    ["~~~md", "```", "~~~"],
    ["   ````md", "   ```", "   ````\t"],
    ["```md", "``` trailing", "```"],
    ["```md", "```\u2028", "```"],
    ["~~~md\u2029info", "~~~\u2029", "~~~"],
  ])("excludes fenced sections, references and images for %s", async (open, falseClose, close) => {
    const text = ["# Start", open, falseClose, "# CODEFENCELEAK", "EXAMPLEBODY", "![fake](wrong.png)", "[ref]: wrong.png", close,
      "# Real tail", "before", "![real][ref]", "after", "[ref]: real.png"].join("\n");
    const result = await parse(text);
    expect(scanMarkdownLines(text).find(line => line.raw === "EXAMPLEBODY")).toMatchObject({ kind: "code", source: "fenced" });
    expect(result.sections.map(section => section.title)).toEqual(["Start", "Real tail"]);
    expect(result.sections[1]?.text).toContain("after");
    expect(JSON.stringify(result)).not.toContain("EXAMPLEBODY");
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]?.resolvedRelativePath).toBe("real.png");
    expect(result.occurrences[0]?.beforeText).toBe("before");
    expect(result.occurrences[0]?.afterText).toContain("after");
    expect(markdownHeadings(text)).toEqual([{ id: "md-heading-1", title: "Start" }, { id: "md-heading-9", title: "Real tail" }]);
  });

  it("does not resolve a real image through a fenced reference definition", async () => {
    const result = await parse("```\n[hidden]: wrong.png\n```\n![real][hidden]\n");
    expect(result.occurrences).toEqual([]);
  });

  it("keeps physical line numbers, literal hashes, Setext, preamble and heading-only sections", async () => {
    const result = await parse("preamble\r\n\rSetext\r===\n# Title#\nbody\u2028same\u2029line\r## Heading only ###\t");
    expect(result.sections.map(section => section.title)).toEqual(["guide", "Setext", "Title#", "Heading only"]);
    expect(result.sections[0]?.text).toBe("preamble");
    expect(result.sections[1]?.locator).toMatchObject({ line: 3 });
    expect(result.sections[2]?.blocks[0]?.locator).toMatchObject({ line: 6 });
    expect(result.sections[2]?.text).toBe("body\u2028same\u2029line");
    expect(result.sections[3]?.blocks).toEqual([]);
  });

  it("preserves indented text literally without headings or media", async () => {
    const text = "#\n    # code\n\t~~~\n    ![fake](wrong.png)\n#Real text\n# Real\nbody\n";
    expect(scanMarkdownLines(text).map(line => line.kind)).toEqual(["heading", "code", "code", "code", "content", "heading", "content", "content"]);
    expect(scanMarkdownLines(text).filter(line => line.kind === "code").map(line => line.source)).toEqual(["indented", "indented", "indented"]);
    const result = await parse(text);
    expect(result.sections.map(section => section.title)).toEqual(["guide", "Real"]);
    expect(result.sections[0]?.text).toBe("# code\n~~~\n![fake](wrong.png)\n#Real text");
    expect(result.sections[0]?.blocks[0]?.locator).toMatchObject({ line: 2 });
    expect(result.occurrences).toEqual([]);
  });

  it("accepts only adjacent usable content for Setext headings", async () => {
    const result = await parse("~~~\nexample\n===\n~~~\n    code\n---\n\nReal\n---\nbody");
    expect(result.sections.map(section => section.title)).toEqual(["guide", "Real"]);
    expect(result.sections[0]?.text).toBe("code\n---");
    expect(result.sections[1]?.text).toBe("body");
    expect(JSON.stringify(result)).not.toContain("example");
  });
});
