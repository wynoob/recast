import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAssetMapDocument,
  titleFromFileName,
  type AssetMapSelectedItem,
} from "@dmall/domain";

const mappingId = "00000000-0000-4000-8000-000000000001";

describe("markdown-asset-table/v1 parser", () => {
  const exampleTable = "| File | Use |\n|---|---|\n| image.png | EXAMPLE |";

  it.each([
    ["backtick U+2028", "```", "\u2028"],
    ["backtick U+2029", "```", "\u2029"],
    ["tilde U+2028", "~~~", "\u2028"],
    ["tilde U+2029", "~~~", "\u2029"],
  ])("keeps example tables inside a %s info-string fence", (_name, marker, separator) => {
    const result = parse([
      `${marker}markdown${separator}example`, exampleTable, marker,
    ].join("\n"), ["image.png"]);
    expect(result).toMatchObject({ ok: false, errorCode: "MAPPING_FORMAT_NOT_FOUND" });
    expect("entries" in result).toBe(false);
  });

  it.each([
    ["shorter backticks", "````markdown", "```"],
    ["shorter tildes", "~~~~markdown", "~~~"],
    ["different character", "````", "~~~~"],
    ["different character after tildes", "~~~~", "````"],
    ["non-whitespace suffix", "```", "```text"],
    ["suffix after spaces", "~~~", "~~~ \ttext"],
    ["four-space closing indentation", "```", "    ```"],
    ["non-ASCII trailing space", "```", "```\u00a0"],
    ["unclosed fence", "```markdown", ""],
  ])("keeps tables inside a fence with %s", (_name, opening, falseClosing) => {
    const result = parse([opening, falseClosing, exampleTable].join("\n"), ["image.png"]);
    expect(result).toMatchObject({ ok: false, errorCode: "MAPPING_FORMAT_NOT_FOUND" });
    expect("entries" in result).toBe(false);
  });

  it.each([
    ["ordinary backticks", "```markdown", "```"],
    ["longer closing backticks", "````markdown", "`````"],
    ["ordinary tildes", "~~~markdown", "~~~"],
    ["longer closing tildes", "~~~~", "~~~~~"],
    ["three-space indentation and trailing whitespace", "   ````markdown", "   ```` \t"],
  ])("parses only the outside table after %s", (_name, opening, closing) => {
    const result = parse([
      "# Real section", opening, exampleTable, closing, "", exampleTable.replace("EXAMPLE", "REAL"),
    ].join("\n"), ["image.png"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      usageText: "REAL", sectionHeading: "Real section", lineStart: 10, lineEnd: 10,
      tableIndex: 0, rowIndex: 0, rowKey: "t0:r0",
    });
  });

  it("ignores an ordinary fenced example when there is no outside table", () => {
    expect(parse(["```markdown", exampleTable, "```"].join("\n"), ["image.png"]))
      .toMatchObject({ ok: false, errorCode: "MAPPING_FORMAT_NOT_FOUND" });
  });

  it("does not open a fence indented four spaces", () => {
    const result = parse(["    ```", "", exampleTable].join("\n"), ["image.png"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(1);
  });

  it("parses the real fixture with exact File, Use, section, line, and null Title", async () => {
    const relativePaths = [
      "public/assets/brand/dmall-logo.png",
      "public/assets/素材-昨日销量情况.mp4",
      "public/assets/source/DD-3.mp4",
      "public/assets/source/1111.mp4",
      "public/assets/source/DD-8.mp4",
      "public/assets/source/DD-91.mp4",
      "public/assets/source/DDD-2.mp4",
      "public/assets/source/DDD-2-2.mp4",
      "public/assets/source/DD-88.mp4",
      "public/assets/source/d-7.mp4",
      "public/assets/legacy/DD-2.gif",
      "public/assets/legacy/DDD-1.gif",
      "public/assets/legacy/d-10.gif",
    ];
    const snapshot = await readFile(
      join(
        process.cwd(),
        "input/Dmall内容工作台-完整交接包-v1.0/materials/local/docs/asset-map.md",
      ),
    );
    const result = parseAssetMapDocument({
      mapIndex: 0,
      mapping: {
        scanItemId: mappingId,
        relativePath: "docs/asset-map.md",
        kind: "markdown",
        bytes: snapshot.byteLength,
      },
      snapshotBytes: snapshot,
      selectedItems: mediaItems(relativePaths),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warningCount).toBe(0);
    expect(result.entries).toHaveLength(13);
    expect(result.entries.map((entry) => entry.fileCell)).toEqual([
      "`public/assets/brand/dmall-logo.png`",
      "`public/assets/素材-昨日销量情况.mp4`",
      "`public/assets/source/DD-3.mp4`",
      "`public/assets/source/1111.mp4`",
      "`public/assets/source/DD-8.mp4`",
      "`public/assets/source/DD-91.mp4`",
      "`public/assets/source/DDD-2.mp4`",
      "`public/assets/source/DDD-2-2.mp4`",
      "`public/assets/source/DD-88.mp4`",
      "`public/assets/source/d-7.mp4`",
      "`public/assets/legacy/DD-2.gif`",
      "`public/assets/legacy/DDD-1.gif`",
      "`public/assets/legacy/d-10.gif`",
    ]);
    expect(result.entries.map((entry) => entry.lineStart)).toEqual([
      9, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29, 30, 31,
    ]);
    expect(result.entries.map((entry) => entry.sectionHeading)).toEqual([
      "Asset Map / Brand Assets",
      ...Array(9).fill("Asset Map / Primary Source Assets"),
      ...Array(3).fill("Asset Map / Legacy Fallback Assets"),
    ]);
    expect(result.entries.every((entry) => entry.titleText === null)).toBe(true);
    expect(result.entries.map((entry) => entry.tableIndex)).toEqual([
      0,
      ...Array(9).fill(1),
      ...Array(3).fill(2),
    ]);
    expect(result.entries.map((entry) => entry.rowIndex)).toEqual([
      0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2,
    ]);
    expect(result.entries[0]?.usageMarkdown).toBe(
      "Official Dmall logo downloaded from `https://apppublish.dmall.com/dhc/file/logo@3x.png`; used in the opening system visual and product window chrome.",
    );
    expect(result.entries[0]?.usageText).toBe(
      "Official Dmall logo downloaded from https://apppublish.dmall.com/dhc/file/logo@3x.png; used in the opening system visual and product window chrome.",
    );
    expect(result.entries[7]?.usageMarkdown).toBe(
      "Transfer / loss analysis extended scene; preferred source for action loop.",
    );
    expect(result.entries[12]?.usageMarkdown).toBe(
      "Complex task fallback scene. Deprecated for the short mainline because source quality is weaker than the new diagnosis case.",
    );
  });

  it("supports header order, escaped pipes, code-span paths, leading ./, and sections", () => {
    const markdown = [
      "# 一级",
      "",
      "## 二级",
      "",
      "| Title | Use | File |",
      "|---|:---:|---|",
      "| 人工标题 | 说明 **重点** 与 `a|b` | `./public/assets/a\\|b.png` |",
      "",
    ].join("\n");
    const result = parse(markdown, ["public/assets/a|b.png"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      fileCell: "`./public/assets/a\\|b.png`",
      normalizedRelativePath: "public/assets/a|b.png",
      titleText: "人工标题",
      usageMarkdown: "说明 **重点** 与 `a|b`",
      usageText: "说明 重点 与 a|b",
      sectionHeading: "一级 / 二级",
      lineStart: 7,
      lineEnd: 7,
    });
  });

  it("warns and skips unsafe, unselected, and non-media paths without reading files", () => {
    const markdown = [
      "| File | Use |",
      "|---|---|",
      "| https://example.com/a.png | external |",
      "| file:///tmp/a.png | file url |",
      "| /tmp/a.png | absolute |",
      "| ../a.png | traversal |",
      "| public\\a.png | backslash |",
      "| bad\u0000.png | control |",
      "| public/unselected.png | missing selection |",
      "| docs/note.md | markdown selection |",
      "| public/not-on-disk.png | selected-by-relative-path |",
      "|  | empty file |",
      "| public/empty-use.png |  |",
    ].join("\n");
    const result = parse(markdown, ["public/not-on-disk.png", "public/empty-use.png"], [
      {
        scanItemId: "00000000-0000-4000-8000-000000000099",
        relativePath: "docs/note.md",
        kind: "markdown",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.normalizedRelativePath).toBe("public/not-on-disk.png");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "EXTERNAL_PATH",
      "ABSOLUTE_PATH",
      "ABSOLUTE_PATH",
      "OUTSIDE_ROOT",
      "OUTSIDE_ROOT",
      "OUTSIDE_ROOT",
      "PATH_NOT_SELECTED",
      "PATH_NOT_MEDIA",
      "EMPTY_FILE",
      "EMPTY_USE",
    ]);
  });

  it("enforces the 200 code point Title and leaves absent Title null", () => {
    const valid = parse(
      [
        "| File | Use | Title |",
        "|---|---|---|",
        `| public/a.png | 用法 | ${"😀".repeat(200)} |`,
        "| public/b.png | 用法 |  |",
      ].join("\n"),
      ["public/a.png", "public/b.png"],
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.entries).toHaveLength(2);
    expect(valid.entries[0]?.titleText).toBe("😀".repeat(200));
    expect(valid.entries[1]?.titleText).toBeNull();

    const invalid = parse(
      [
        "| File | Use | Title |",
        "|---|---|---|",
        `| public/a.png | 用法 | ${"😀".repeat(201)} |`,
      ].join("\n"),
      ["public/a.png"],
    );
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(invalid.entries).toHaveLength(0);
    expect(invalid.warnings.map((warning) => warning.code)).toEqual([
      "INVALID_TITLE",
      "MAPPING_EMPTY",
    ]);
    expect([...titleFromFileName(`${"😀".repeat(201)}.png`)]).toHaveLength(200);
  });

  it("fails explicitly at 16KiB cells and 5000 rows", () => {
    const boundaryPath = "a".repeat(16_384);
    const exact = parse(
      ["| File | Use |", "|---|---|", `| ${boundaryPath} | 用法 |`].join("\n"),
      [boundaryPath],
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.entries).toHaveLength(1);

    const tooLargePath = "b".repeat(16_385);
    const tooLarge = parse(
      ["| File | Use |", "|---|---|", `| ${tooLargePath} | 用法 |`].join("\n"),
      [tooLargePath],
    );
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.errorCode).toBe("MAPPING_CELL_TOO_LARGE");
      expect(tooLarge.warnings.at(-1)?.code).toBe("ROW_TOO_LARGE");
    }

    const rows = Array.from({ length: 5001 }, () => "| public/a.png | 用法 |");
    const overRows = parse(
      ["| File | Use |", "|---|---|", ...rows].join("\n"),
      ["public/a.png"],
    );
    expect(overRows.ok).toBe(false);
    if (!overRows.ok) expect(overRows.errorCode).toBe("MAPPING_ROW_LIMIT_EXCEEDED");
  });

  it("fails at warning 5001 without truncating into success", () => {
    const unsupported = [
      "| File | Use | Extra |",
      "|---|---|---|",
      "| public/a.png | 用法 | extra |",
      "",
      "",
    ].join("\n");
    const valid = ["| File | Use |", "|---|---|", "| public/a.png | 用法 |", ""].join("\n");
    const exactly5000 = parse(`${unsupported.repeat(5000)}${valid}`, ["public/a.png"]);
    expect(exactly5000.ok).toBe(true);
    if (exactly5000.ok) {
      expect(exactly5000.warningCount).toBe(5000);
      expect(exactly5000.warnings).toHaveLength(5000);
      expect(exactly5000.entries).toHaveLength(1);
    }

    const overLimit = parse(`${unsupported.repeat(5001)}${valid}`, ["public/a.png"]);
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.errorCode).toBe("MAPPING_WARNING_LIMIT_EXCEEDED");
      expect(overLimit.warningCount).toBe(5001);
      expect(overLimit.warnings).toHaveLength(5000);
    }
  });

  it("rejects invalid UTF-8, oversized documents, and non-standard tables", () => {
    const invalidUtf8 = parseBytes(Uint8Array.from([0xff, 0xfe, 0x00]), []);
    expect(invalidUtf8.ok).toBe(false);
    if (!invalidUtf8.ok) expect(invalidUtf8.errorCode).toBe("MAPPING_NOT_UTF8");

    const oversized = parseBytes(new Uint8Array(1_048_577), []);
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.errorCode).toBe("MAPPING_READ_FAILED");

    const noTable = parse("# 只有标题\n\nFile | Use\npublic/a.png | 用法", ["public/a.png"]);
    expect(noTable.ok).toBe(false);
    if (!noTable.ok) {
      expect(noTable.errorCode).toBe("MAPPING_FORMAT_NOT_FOUND");
      expect(noTable.warnings.map((warning) => warning.code)).toContain(
        "MAPPING_FORMAT_NOT_FOUND",
      );
    }
  });
});

function parse(markdown: string, paths: string[], extra: AssetMapSelectedItem[] = []) {
  return parseBytes(Buffer.from(markdown), paths, extra);
}

function parseBytes(
  bytes: Uint8Array,
  paths: string[],
  extra: AssetMapSelectedItem[] = [],
) {
  return parseAssetMapDocument({
    mapIndex: 0,
    mapping: {
      scanItemId: mappingId,
      relativePath: "docs/source.md",
      kind: "markdown",
      bytes: bytes.byteLength,
    },
    snapshotBytes: bytes,
    selectedItems: [...mediaItems(paths), ...extra],
  });
}

function mediaItems(paths: string[]): AssetMapSelectedItem[] {
  return paths.map((relativePath, index) => ({
    scanItemId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    relativePath,
    kind: relativePath.endsWith(".png")
      ? "image"
      : relativePath.endsWith(".gif")
        ? "gif"
        : "video",
  }));
}
