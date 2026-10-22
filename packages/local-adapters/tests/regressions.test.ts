import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractPdf, extractPptx, extractStaticHtml } from "../src/index.js";
import { ONE_PIXEL_PNG, makePdf, makeStaging, minimalPptx, sha256 } from "./fixtures.js";

async function htmlFixture(html: string) {
  const root = await makeStaging("regression-html");
  const sourcePath = join(root, "index.html");
  await writeFile(sourcePath, html);
  await writeFile(join(root, "a.png"), ONE_PIXEL_PNG);
  await writeFile(join(root, "b.png"), Buffer.concat([ONE_PIXEL_PNG, Buffer.from("second")]));
  return { sourcePath, stagingDir: join(root, "staging") };
}

function editPptx(edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(minimalPptx({ paragraphs: ["Body"], notes: "" }));
  edit(files);
  return zipSync(files);
}

function editXml(files: Record<string, Uint8Array>, path: string, edit: (xml: string) => string): void {
  const file = files[path];
  if (file === undefined) throw new Error(`Missing fixture part ${path}`);
  files[path] = strToU8(edit(strFromU8(file)));
}

async function pptxFixture(bytes: Uint8Array) {
  const root = await makeStaging("regression-pptx");
  const sourcePath = join(root, "sample.pptx");
  await writeFile(sourcePath, bytes);
  return { sourcePath, stagingDir: join(root, "staging") };
}

async function stagedFiles(stagingDir: string): Promise<string[]> {
  return readdir(join(stagingDir, "media")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

describe("T03-F1 static text and XML fidelity", () => {
  it("retains mixed div/span text exactly once in DOM order and leaves source unchanged", async () => {
    const input = await htmlFixture('<h1>经营结论</h1>开头<div>真实结论 <span>本期增长12%</span><p>辅助说明</p>尾部</div><p>重复</p><p>重复</p>');
    const before = sha256(await readFile(input.sourcePath));
    const result = await extractStaticHtml(input);
    expect(result.sections.flatMap(s => s.blocks.map(b => b.text))).toEqual([
      "开头", "真实结论 本期增长12%", "辅助说明", "尾部", "重复", "重复",
    ]);
    expect(result.status).toBe("complete");
    expect(sha256(await readFile(input.sourcePath))).toBe(before);
  });

  it("anchors media between inline texts without folding later text into beforeText", async () => {
    const result = await extractStaticHtml(await htmlFixture('<h1>节</h1><div>前<span>事实</span><img src="a.png">后<span>事实</span></div>'));
    expect(result.sections[0]?.blocks.map(b => b.text)).toEqual(["前事实", "后事实"]);
    expect(result.occurrences[0]).toMatchObject({ beforeText: "前事实", afterText: "后事实" });
  });

  it("excludes inert/hidden trees but retains surrounding text and br separation", async () => {
    const result = await extractStaticHtml(await htmlFixture('<h1>节</h1><div>甲<br>乙<script>BAD_SCRIPT</script><style>BAD_STYLE</style><template>BAD_TEMPLATE</template><span hidden>BAD_HIDDEN</span><span style="display: none">BAD_DISPLAY</span>丙</div>'));
    expect(result.sections[0]?.blocks.map(b => b.text)).toEqual(["甲\n乙丙"]);
    expect(result.status).toBe("partial");
  });

  it("keeps a heading-only static document usable", async () => {
    const result = await extractStaticHtml(await htmlFixture("<h1>可见标题</h1>"));
    expect(result.sections[0]?.title).toBe("可见标题");
    expect(result.status).toBe("complete");
  });

  it("preserves media nested in a heading without duplicating heading text", async () => {
    const result = await extractStaticHtml(await htmlFixture('<h1>标题<img src="a.png"></h1><p>正文</p>'));
    expect(result.sections[0]?.title).toBe("标题");
    expect(result.sections[0]?.blocks.map(b => b.text)).toEqual(["正文"]);
    expect(result.media).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({ beforeText: "", afterText: "正文" });
  });

  it("decodes predefined entities once in text, notes and metadata", async () => {
    const bytes = minimalPptx({ paragraphs: ['A & B < C > D "quoted" \'apostrophe\' &amp;'], notes: "A & B" });
    const result = await extractPptx(await pptxFixture(bytes));
    expect(result.sections[0]?.blocks[0]?.text).toBe('A & B < C > D "quoted" \'apostrophe\' &amp;');
    expect(result.sections[0]?.notes).toBe("A & B");
  });

  it("decodes decimal and hexadecimal character references, including supplementary Unicode", async () => {
    const bytes = editPptx(files => {
      editXml(files, "ppt/slides/slide1.xml", xml => xml.replace("<a:t>Body</a:t>", "<a:t>&#65;&#x4E2D;&#x1F600;&apos;</a:t>"));
      editXml(files, "docProps/core.xml", xml => xml.replace("合成 PPTX", "A &amp; B"));
    });
    const result = await extractPptx(await pptxFixture(bytes));
    expect(result.sections[0]?.blocks[0]?.text).toBe("A中😀'");
    expect(result.title).toBe("A & B");
  });

  it.each(["&unknown;", "&#0;", "&#xD800;", "&#x110000;", "&broken"])("rejects unsafe or invalid XML reference %s", async entity => {
    const input = await pptxFixture(editPptx(files => editXml(files, "ppt/slides/slide1.xml", xml => xml.replace("<a:t>Body</a:t>", `<a:t>${entity}</a:t>`))));
    await expect(extractPptx(input)).rejects.toMatchObject({ code: "SOURCE_UNREADABLE" });
  });

  it("rejects DOCTYPE and custom entities without expansion", async () => {
    const input = await pptxFixture(editPptx(files => editXml(files, "ppt/slides/slide1.xml", xml => '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///never-read">]>' + xml)));
    await expect(extractPptx(input)).rejects.toMatchObject({ code: "SOURCE_UNREADABLE" });
  });
});

describe("T03-F2 enforce shared extraction budgets before materialization", () => {
  it.each(["pptx", "pdf", "html"] as const)("rejects over-limit %s text", async format => {
    const root = await makeStaging(`regression-text-${format}`);
    const sourcePath = join(root, `sample.${format}`);
    const bytes = format === "pptx" ? minimalPptx({ paragraphs: ["TEXT-LONGER-THAN-FIVE"], notes: "" })
      : format === "pdf" ? await makePdf(["TEXT-LONGER-THAN-FIVE"])
      : "<p>TEXT-LONGER-THAN-FIVE</p>";
    await writeFile(sourcePath, bytes);
    const input = { sourcePath, stagingDir: join(root, "staging"), options: { renderPdfPages: false, limits: { maxTextCharsPerDocument: 5 } } };
    const extract = format === "pptx" ? extractPptx : format === "pdf" ? extractPdf : extractStaticHtml;
    await expect(extract(input)).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(await stagedFiles(input.stagingDir)).toEqual([]);
  });

  it("includes PPTX notes in cumulative text budget", async () => {
    const files = unzipSync(minimalPptx({ paragraphs: ["A"], notes: "Notes exceed limit" }));
    delete files["docProps/core.xml"];
    const input = await pptxFixture(zipSync(files));
    await expect(extractPptx({ ...input, options: { limits: { maxTextCharsPerDocument: 5 } } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("includes HTML headings in text budget", async () => {
    const input = await htmlFixture("<h1>Heading exceeds limit</h1><p>A</p>");
    await expect(extractStaticHtml({ ...input, options: { limits: { maxTextCharsPerDocument: 5 } } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("accumulates PDF text across pages", async () => {
    const root = await makeStaging("regression-pdf-total");
    const sourcePath = join(root, "sample.pdf");
    await writeFile(sourcePath, await makePdf(["abc", "def"]));
    await expect(extractPdf({ sourcePath, stagingDir: join(root, "staging"), options: { renderPdfPages: false, limits: { maxTextCharsPerDocument: 5 } } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("accepts exact text capacity without counting derived titles/context twice", async () => {
    const input = await pptxFixture(editPptx(files => { delete files["docProps/core.xml"]; }));
    const result = await extractPptx({ ...input, options: { limits: { maxTextCharsPerDocument: 4 } } });
    expect(result.sections[0]?.blocks[0]?.text).toBe("Body");
  });

  it.each(["bound", "unbound"])("rejects excess %s PPTX resources before any media staging", async kind => {
    const input = await pptxFixture(editPptx(files => {
      files["ppt/media/second.png"] = Buffer.concat([ONE_PIXEL_PNG, Buffer.from("second")]);
      if (kind === "bound") {
        editXml(files, "ppt/slides/slide1.xml", xml => xml.replace("</p:spTree>", '<p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic></p:spTree>'));
        editXml(files, "ppt/slides/_rels/slide1.xml.rels", xml => xml.replace("</Relationships>", '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/second.png"/></Relationships>'));
      }
    }));
    await expect(extractPptx({ ...input, options: { limits: { maxMediaFiles: 1 } } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(await stagedFiles(input.stagingDir)).toEqual([]);
  });

  it("rejects excess HTML media before staging the excess resource", async () => {
    const input = await htmlFixture('<p>Body</p><img src="a.png"><img src="b.png">');
    await expect(extractStaticHtml({ ...input, options: { limits: { maxMediaFiles: 1 } } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    const files = await stagedFiles(input.stagingDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(sha256(ONE_PIXEL_PNG));
  });

  it("counts missing HTML resources and deduplicates repeated resource references", async () => {
    const input = await htmlFixture('<p>Body</p><img src="missing.png"><img src="other.png">');
    await expect(extractStaticHtml({ ...input, options: { limits: { maxMediaFiles: 1 } } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    const repeated = await htmlFixture('<p>Body</p><img src="a.png"><img src="a.png">');
    const result = await extractStaticHtml({ ...repeated, options: { limits: { maxMediaFiles: 1 } } });
    expect(result.media).toHaveLength(1);
    expect(result.occurrences).toHaveLength(2);
  });

  it.each(["media", "pageImages"])("rejects PDF %s overflow before rendering/staging", async kind => {
    const root = await makeStaging("regression-pdf-media");
    const sourcePath = join(root, "sample.pdf");
    await writeFile(sourcePath, await makePdf(["One", "Two"]));
    const limits = kind === "media" ? { maxMediaFiles: 1 } : { maxPageImages: 1 };
    const stagingDir = join(root, "staging");
    await expect(extractPdf({ sourcePath, stagingDir, options: { limits } })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(await stagedFiles(stagingDir)).toEqual([]);
    expect((await readdir(stagingDir)).filter(name => name.startsWith(".pdf-render"))).toEqual([]);
  });
});

describe("T03-F3 nearest context and Unicode", () => {
  it("retains nearest two blocks with before suffix and after prefix in reading order", async () => {
    const result = await extractStaticHtml(await htmlFixture('<h1>Context</h1><p>excluded</p><p>'+"远".repeat(1100)+'</p><p>最近事实B</p><img src="a.png"><p>最近事实C</p><p>'+"后".repeat(1100)+'</p><p>excluded-after</p>'));
    const occurrence = result.occurrences[0];
    expect(occurrence?.beforeText).toMatch(/远+\n最近事实B$/u);
    expect(occurrence?.afterText).toMatch(/^最近事实C\n后+/u);
    expect(occurrence?.beforeText).not.toContain("excluded");
    expect(occurrence?.afterText).not.toContain("excluded-after");
    expect((occurrence?.beforeText.length ?? 0) + (occurrence?.afterText.length ?? 0)).toBeLessThanOrEqual(2000);
  });

  it("does not split supplementary Unicode at either truncation boundary", async () => {
    const before = "😀".repeat(501);
    const after = "x" + "😀".repeat(501);
    const result = await extractStaticHtml(await htmlFixture(`<p>${before}</p><img src="a.png"><p>${after}</p>`));
    const occurrence = result.occurrences[0];
    expect(occurrence).toBeDefined();
    for (const text of [occurrence?.beforeText ?? "", occurrence?.afterText ?? ""]) {
      expect(Buffer.from(text).toString("utf8")).toBe(text);
      expect(text.length).toBeLessThanOrEqual(1000);
    }
  });
});
