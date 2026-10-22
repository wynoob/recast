import { extname } from "node:path";

export type MagicKind =
  | "image"
  | "gif"
  | "video"
  | "markdown"
  | "pdf"
  | "pptx"
  | "html"
  | "html_zip"
  | "unsupported";

export interface MagicSniffResult {
  kind: MagicKind;
  mime: string | null;
  extension: string;
  extensionMismatch: boolean;
}

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "m4v ",
  "M4V ",
  "M4VP",
  "MSNV",
  "qt  ",
  "3gp4",
  "3gp5",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const GIF_EXTENSIONS = new Set([".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const PPTX_EXTENSIONS = new Set([".pptx"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const ZIP_EXTENSIONS = new Set([".zip"]);

export function sniffMagic(
  header: Uint8Array,
  fileName: string,
  textSample: string | null,
): MagicSniffResult {
  const extension = extname(fileName).toLowerCase();
  const detected = detect(header, extension, textSample);
  const expectedExtensions =
    detected.kind === "image"
      ? IMAGE_EXTENSIONS
      : detected.kind === "gif"
        ? GIF_EXTENSIONS
        : detected.kind === "video"
          ? VIDEO_EXTENSIONS
          : detected.kind === "markdown"
            ? MARKDOWN_EXTENSIONS
            : detected.kind === "pdf"
              ? PDF_EXTENSIONS
              : detected.kind === "pptx"
                ? PPTX_EXTENSIONS
                : detected.kind === "html"
                  ? HTML_EXTENSIONS
                  : detected.kind === "html_zip"
                    ? ZIP_EXTENSIONS
                    : new Set<string>();
  return {
    kind: detected.kind,
    mime: detected.mime,
    extension,
    extensionMismatch: detected.kind !== "unsupported" && !expectedExtensions.has(extension),
  };
}

function detect(
  header: Uint8Array,
  extension: string,
  textSample: string | null,
): { kind: MagicKind; mime: string | null } {
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mime: "image/png" };
  }
  if (startsWith(header, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mime: "image/jpeg" };
  }
  if (
    ascii(header, 0, 6) === "GIF87a" ||
    ascii(header, 0, 6) === "GIF89a"
  ) {
    return { kind: "gif", mime: "image/gif" };
  }
  if (ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "WEBP") {
    return { kind: "image", mime: "image/webp" };
  }
  if (ascii(header, 4, 4) === "ftyp") {
    for (let offset = 8; offset + 4 <= Math.min(header.byteLength, 64); offset += 4) {
      const brand = ascii(header, offset, 4);
      if (MP4_BRANDS.has(brand)) return { kind: "video", mime: "video/mp4" };
    }
  }
  if (ascii(header, 0, 5) === "%PDF-") {
    return { kind: "pdf", mime: "application/pdf" };
  }
  if (ascii(header, 0, 4) === "PK\u0003\u0004") {
    if (PPTX_EXTENSIONS.has(extension)) {
      return {
        kind: "pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      };
    }
    if (ZIP_EXTENSIONS.has(extension)) {
      return { kind: "html_zip", mime: "application/zip" };
    }
  }
  if (MARKDOWN_EXTENSIONS.has(extension) && !header.includes(0) && textSample !== null) {
    return { kind: "markdown", mime: "text/markdown" };
  }
  if (
    HTML_EXTENSIONS.has(extension) &&
    !header.includes(0) &&
    textSample !== null &&
    /<(?:!doctype\s+html|html|head|body|main|section|article|div|p)\b/iu.test(textSample)
  ) {
    return { kind: "html", mime: "text/html" };
  }
  return { kind: "unsupported", mime: null };
}

function startsWith(value: Uint8Array, prefix: number[]): boolean {
  if (value.byteLength < prefix.length) return false;
  return prefix.every((byte, index) => value[index] === byte);
}

function ascii(value: Uint8Array, offset: number, length: number): string {
  if (offset + length > value.byteLength) return "";
  return String.fromCharCode(...value.subarray(offset, offset + length));
}

export function isSupportedExtension(fileName: string): boolean {
  const extension = extname(fileName).toLowerCase();
  return (
    IMAGE_EXTENSIONS.has(extension) ||
    GIF_EXTENSIONS.has(extension) ||
    VIDEO_EXTENSIONS.has(extension) ||
    MARKDOWN_EXTENSIONS.has(extension) ||
    PDF_EXTENSIONS.has(extension) ||
    PPTX_EXTENSIONS.has(extension) ||
    HTML_EXTENSIONS.has(extension) ||
    ZIP_EXTENSIONS.has(extension)
  );
}
