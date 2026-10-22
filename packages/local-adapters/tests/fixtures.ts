import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Zip, ZipDeflate, zipSync } from "fflate";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const INPUT_ROOT = join(
  REPO_ROOT,
  "input/Dmall内容工作台-完整交接包-v1.0",
);
export const S06_PATH = join(
  INPUT_ROOT,
  "materials/feishu/S06-Dmall OS AI智能体产品与技术内核分享.pptx",
);
export const S08_PATH = join(
  INPUT_ROOT,
  "materials/feishu/S08-多点OS 小助手agent产品介绍.pptx",
);

export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2kAAAAASUVORK5CYII=",
  "base64",
);

export async function makeStaging(label: string): Promise<string> {
  const root = tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${label}-`));
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function minimalPptx(args?: {
  readonly externalImage?: boolean;
  readonly notes?: string;
  readonly paragraphs?: readonly string[];
  readonly media?: Uint8Array;
}): Uint8Array {
  const paragraphs = args?.paragraphs ?? ["标题 A", "正文 B"];
  const media = args?.media ?? new Uint8Array(ONE_PIXEL_PNG);
  const external = args?.externalImage === true;
  const notes = args?.notes ?? "讲解备注";
  const slideParagraphs = paragraphs
    .map((text) => `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`)
    .join("");
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree>
  <p:sp><p:txBody>${slideParagraphs}</p:txBody></p:sp>
  <p:pic><p:blipFill><a:blip r:embed="${external ? "rId4" : "rId3"}"/></p:blipFill></p:pic>
 </p:spTree></p:cSld>
</p:sld>`;
  const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
 <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/blocked.png" TargetMode="External"/>
</Relationships>`;
  const notesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": utf8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
    ),
    "docProps/core.xml": utf8(
      `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>合成 PPTX</dc:title></cp:coreProperties>`,
    ),
    "ppt/presentation.xml": utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": utf8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    ),
    "ppt/slides/slide1.xml": utf8(slide),
    "ppt/slides/_rels/slide1.xml.rels": utf8(slideRels),
    "ppt/notesSlides/notesSlide1.xml": utf8(notesXml),
    "ppt/media/image1.png": media,
  };
  return zipSync(files);
}

export function twoSlidePptx(): Uint8Array {
  const slide = (text: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
  return zipSync({
    "[Content_Types].xml": utf8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    ),
    "ppt/presentation.xml": utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" r:id="rId10"/><p:sldId id="256" r:id="rId11"/></p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": utf8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    ),
    "ppt/slides/slide1.xml": utf8(slide("File one")),
    "ppt/slides/slide2.xml": utf8(slide("File two")),
  });
}

export function maliciousZip(name: string): Uint8Array {
  return zipSync({
    [name]: utf8("blocked"),
  });
}

export function expansionZip(expandedBytes: number): Uint8Array {
  return zipSync({
    "bomb.txt": new Uint8Array(expandedBytes),
  });
}

export async function duplicateNameZip(name: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk, final) => {
    if (error !== null) throw error;
    chunks.push(chunk);
    if (final) return;
  });
  for (const text of ["first", "second"]) {
    const file = new ZipDeflate(name);
    zip.add(file);
    file.push(utf8(text), true);
  }
  zip.end();
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function makePdf(pages: readonly string[]): Promise<Uint8Array> {
  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 2);
  const fontObject = 3 + pages.length * 2;
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  for (const [index, text] of pages.entries()) {
    const pageObject = pageObjectNumbers[index];
    if (pageObject === undefined) throw new Error("PDF page object missing");
    const contentObject = pageObject + 1;
    const content = `BT /F1 12 Tf 72 720 Td ${pdfString(text)} Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  }
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

export async function writeFixture(path: string, data: Uint8Array | string): Promise<void> {
  await writeFile(path, data);
}

function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pdfString(value: string): string {
  return `(${value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;
}
