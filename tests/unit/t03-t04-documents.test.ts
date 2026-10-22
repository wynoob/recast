import { describe, expect, it } from "vitest";
import { chunkSections, ChunkSectionsInputSchema } from "@dmall/search";
import { FactVersionInputSchema } from "@dmall/contracts";
import { parseMarkdownDocument } from "../../apps/worker/src/markdown.js";

describe("T03/T04 document shapes", () => {
  it("keeps preamble and heading-only Markdown sections with positive line locators", async () => {
    const document = await parseMarkdownDocument({
      text: [
        "前言正文",
        "",
        "# 第一章",
        "",
        "第一章正文",
        "**加粗正文** <image token=\"secret\" width=\"1\"/> <lark-td>库存</lark-td> {align=\"right\"}",
        "",
        "## 只有标题",
      ].join("\n"),
      rootPath: "/tmp",
      relativePath: "guide.md",
      knownFiles: [],
    });
    expect(document.sections.map((section) => section.title)).toEqual([
      "guide",
      "第一章",
      "只有标题",
    ]);
    expect(document.sections[2]?.blocks).toEqual([]);
    expect(document.sections[1]?.text).toContain("加粗正文");
    expect(document.sections[1]?.text).not.toContain("**");
    expect(document.sections[1]?.text).not.toContain("secret");
    expect(document.sections[1]?.text).not.toContain("align");
    for (const section of document.sections) {
      expect(section.locator).toMatchObject({
        kind: "markdown_text",
        line: expect.any(Number),
        column: 1,
      });
      if (section.locator.kind === "markdown_text") {
        expect(section.locator.line).toBeGreaterThan(0);
      }
      for (const block of section.blocks) {
        expect(block.locator).toMatchObject({
          kind: "markdown_text",
          line: expect.any(Number),
        });
        if (block.locator.kind === "markdown_text") {
          expect(block.locator.line).toBeGreaterThan(0);
        }
      }
    }
  });

  it("emits a title-only chunk when a section has no body blocks", () => {
    const drafts = chunkSections(
      ChunkSectionsInputSchema.parse([
        {
          sectionId: "sec-title",
          title: "只有标题",
          page: null,
          sourceVersionId: "00000000-0000-4000-8000-000000000001",
          tags: [],
          metadata: {
            merchantId: null,
            mediaKind: "document",
            recordDate: null,
            effectiveFrom: null,
            effectiveTo: null,
            audience: [],
            functions: [],
            obsolete: false,
            availability: "available",
          },
          blocks: [],
        },
      ]),
      { makeChunkRefId: () => "00000000-0000-5000-8000-000000000001" },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.blockIds).toEqual([]);
    expect(drafts[0]?.sectionId).toBe("sec-title");
    expect(drafts[0]?.candidate.text).toBe("只有标题");
  });

  it("counts fact index text by Unicode code point and rejects 1201", () => {
    const base = {
      value: 1,
      unit: "个",
      merchantId: null,
      period: null,
      kind: "measured" as const,
      sourceVersionId: "00000000-0000-4000-8000-000000000001",
      sourceLocator: { kind: "page" as const, page: 1 },
      status: "unverified" as const,
    };
    expect(
      FactVersionInputSchema.safeParse({
        ...base,
        indexText: "😀".repeat(1_200),
      }).success,
    ).toBe(true);
    expect(
      FactVersionInputSchema.safeParse({
        ...base,
        indexText: "😀".repeat(1_201),
      }).success,
    ).toBe(false);
  });
});
