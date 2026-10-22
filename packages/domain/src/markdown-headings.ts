export interface MarkdownHeading {
  id: string;
  title: string;
}

export type MarkdownLine =
  | { kind: "content"; lineNumber: number; raw: string }
  | { kind: "fence"; lineNumber: number; raw: string }
  | { kind: "code"; source: "fenced" | "indented"; lineNumber: number; raw: string }
  | { kind: "heading"; lineNumber: number; raw: string; level: number; title: string };

export function scanMarkdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const [index, line] of text.split(/\r\n|\r|\n/u).entries()) {
    const physicalLine = { lineNumber: index + 1, raw: line };
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
    const run = marker?.[1];
    const tail = marker?.[2];
    if (fence !== null) {
      if (run !== undefined && run[0] === fence.marker && run.length >= fence.length && /^[ \t]*$/u.test(tail ?? "")) {
        fence = null;
        lines.push({ ...physicalLine, kind: "fence" });
      } else {
        lines.push({ ...physicalLine, kind: "code", source: "fenced" });
      }
      continue;
    }
    if (run !== undefined && tail !== undefined && (run[0] === "~" || !tail.includes("`"))) {
      fence = { marker: run.startsWith("`") ? "`" : "~", length: run.length };
      lines.push({ ...physicalLine, kind: "fence" });
      continue;
    }
    if (/^(?: {4}| {0,3}\t)/u.test(line)) {
      lines.push({ ...physicalLine, kind: "code", source: "indented" });
      continue;
    }
    const match = /^ {0,3}(#{1,6})(?:[ \t]+([^\r\n]*)|$)/u.exec(line);
    const hashes = match?.[1];
    if (hashes === undefined) {
      lines.push({ ...physicalLine, kind: "content" });
      continue;
    }
    const content = match?.[2] ?? "";
    const title = content.replace(/(?:^|[ \t]+)#+[ \t]*$/u, "").replace(/^[ \t]+|[ \t]+$/gu, "");
    lines.push({ ...physicalLine, kind: "heading", level: hashes.length, title });
  }
  return lines;
}

export function markdownHeadings(text: string): MarkdownHeading[] {
  return scanMarkdownLines(text).flatMap((line) =>
    line.kind === "heading" && line.title !== ""
      ? [{ id: `md-heading-${line.lineNumber}`, title: line.title }]
      : [],
  );
}
