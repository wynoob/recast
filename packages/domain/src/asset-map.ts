import type { AssetMapWarning } from "@dmall/contracts";

export const ASSET_MAP_PARSER_VERSION = "dcw-asset-map/1" as const;
export const ASSET_MAP_DOCUMENT_LIMIT = 1_048_576;
export const ASSET_MAP_ROW_LIMIT = 5000;
export const ASSET_MAP_CELL_LIMIT = 16_384;
export const ASSET_MAP_WARNING_LIMIT = 5000;

export interface AssetMapMappingSource {
  readonly scanItemId: string;
  readonly relativePath: string;
  readonly kind: "markdown";
  readonly bytes: number;
}

export interface AssetMapSelectedItem {
  readonly scanItemId: string;
  readonly relativePath: string;
  readonly kind: "image" | "gif" | "video" | "markdown" | "unsupported";
}

export interface AssetMapEntryDraft {
  readonly mapIndex: number;
  readonly tableIndex: number;
  readonly rowIndex: number;
  readonly rowKey: string;
  readonly sectionHeading: string;
  readonly fileCell: string;
  readonly normalizedRelativePath: string;
  readonly titleText: string | null;
  readonly usageMarkdown: string;
  readonly usageText: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export type AssetMapParseErrorCode =
  | "MAPPING_NOT_UTF8"
  | "MAPPING_ROW_LIMIT_EXCEEDED"
  | "MAPPING_CELL_TOO_LARGE"
  | "MAPPING_WARNING_LIMIT_EXCEEDED"
  | "MAPPING_FORMAT_NOT_FOUND"
  | "MAPPING_READ_FAILED";

export type AssetMapParseResult =
  | {
      readonly ok: true;
      readonly entries: readonly AssetMapEntryDraft[];
      readonly warnings: readonly AssetMapWarning[];
      readonly warningCount: number;
    }
  | {
      readonly ok: false;
      readonly errorCode: AssetMapParseErrorCode;
      readonly warnings: readonly AssetMapWarning[];
      readonly warningCount: number;
    };

export interface ParseAssetMapInput {
  readonly mapIndex: number;
  readonly mapping: AssetMapMappingSource;
  readonly snapshotBytes: Uint8Array;
  readonly selectedItems: readonly AssetMapSelectedItem[];
}

interface Heading {
  readonly level: number;
  readonly title: string;
  readonly line: number;
}

interface MappingAbort {
  readonly errorCode: AssetMapParseErrorCode;
  readonly warnings: AssetMapWarning[];
  readonly warningCount: number;
}

export function parseAssetMapDocument(input: ParseAssetMapInput): AssetMapParseResult {
  if (input.snapshotBytes.byteLength > ASSET_MAP_DOCUMENT_LIMIT) {
    return failure("MAPPING_READ_FAILED", [], 0);
  }
  if (input.mapIndex < 0 || input.mapIndex > 2) {
    return failure("MAPPING_READ_FAILED", [], 0);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.snapshotBytes);
  } catch {
    return failure("MAPPING_NOT_UTF8", [], 0);
  }

  const warnings: AssetMapWarning[] = [];
  let warningCount = 0;
  const addWarning = (warning: AssetMapWarning): void => {
    warningCount += 1;
    if (warningCount > ASSET_MAP_WARNING_LIMIT) {
      throw {
        errorCode: "MAPPING_WARNING_LIMIT_EXCEEDED",
        warnings,
        warningCount,
      } satisfies MappingAbort;
    }
    warnings.push(warning);
  };

  try {
    const lines = text.split(/\r?\n/u);
    const selected = new Map(input.selectedItems.map((item) => [item.relativePath, item]));
    const headings: Heading[] = [];
    const entries: AssetMapEntryDraft[] = [];
    let recognizedRowCount = 0;
    let supportedTableCount = 0;
    let fence: { character: "`" | "~"; length: number } | null = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/us.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1] ?? "```";
        const suffix = fenceMatch[2] ?? "";
        const character = marker.startsWith("`") ? "`" : "~";
        if (fence === null) {
          fence = { character, length: marker.length };
        } else if (
          character === fence.character &&
          marker.length >= fence.length &&
          /^[ \t]*$/u.test(suffix)
        ) {
          fence = null;
        }
        continue;
      }
      if (fence !== null) continue;

      const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (atx !== null) {
        pushHeading(headings, (atx[1] ?? "#").length, (atx[2] ?? "").trim(), lineIndex + 1);
        continue;
      }

      const next = lines[lineIndex + 1] ?? "";
      const setext = /^ {0,3}(=+|-+)\s*$/u.exec(next);
      if (line.trim() !== "" && setext !== null) {
        pushHeading(
          headings,
          (setext[1] ?? "=").startsWith("=") ? 1 : 2,
          line.trim(),
          lineIndex + 1,
        );
        lineIndex += 1;
        continue;
      }

      if (!looksLikeTableRow(line) || !isDelimiterRow(next)) continue;
      const headerLineIndex = lineIndex;
      const headerCells = splitTableRow(line);
      const delimiterCells = splitTableRow(next);
      if (delimiterCells.length !== headerCells.length) continue;
      if (!delimiterCells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell))) continue;

      let rowEnd = headerLineIndex + 2;
      while (rowEnd < lines.length) {
        const rowLine = lines[rowEnd] ?? "";
        if (rowLine.trim() === "" || !looksLikeTableRow(rowLine)) break;
        rowEnd += 1;
      }
      lineIndex = rowEnd - 1;

      const headers = headerCells.map((cell) => cell.trim().toLocaleLowerCase("en-US"));
      const fileIndex = headers.indexOf("file");
      const useIndex = headers.indexOf("use");
      const titleIndex = headers.indexOf("title");
      const uniqueHeaders = new Set(headers);
      const allowedHeaders = headers.every(
        (header) => header === "file" || header === "use" || header === "title",
      );
      if (!allowedHeaders || uniqueHeaders.size !== headers.length) {
        addWarning({
          code: "UNSUPPORTED_COLUMNS",
          tableIndex: null,
          rowIndex: null,
          fileCell: null,
          detail: `不支持的表格列：${headerCells.map((cell) => cell.trim()).join(", ")}`,
        });
        continue;
      }
      if (fileIndex < 0 || useIndex < 0) continue;

      const tableIndex = supportedTableCount;
      supportedTableCount += 1;
      const sectionHeading = headingPath(headings, headerLineIndex + 1);
      let rowIndex = 0;
      for (let dataLine = headerLineIndex + 2; dataLine < rowEnd; dataLine += 1) {
        const rowLine = lines[dataLine] ?? "";
        if (rowLine.trim() === "" || !looksLikeTableRow(rowLine)) continue;
        recognizedRowCount += 1;
        if (recognizedRowCount > ASSET_MAP_ROW_LIMIT) {
          return failure("MAPPING_ROW_LIMIT_EXCEEDED", warnings, warningCount);
        }
        const cells = splitTableRow(rowLine);
        const fileCell = (cells[fileIndex] ?? "").trim();
        const useCell = (cells[useIndex] ?? "").trim();
        const titleRaw = titleIndex < 0 ? "" : (cells[titleIndex] ?? "").trim();
        const usageMarkdown = useCell.replace(/\\\|/gu, "|");
        const usageText = renderUsageText(usageMarkdown);
        const normalizedRelativePath = normalizeFileCell(fileCell);
        const currentRow = rowIndex;
        rowIndex += 1;

        if (utf8Bytes(fileCell) > ASSET_MAP_CELL_LIMIT || utf8Bytes(usageMarkdown) > ASSET_MAP_CELL_LIMIT) {
          addWarning({
            code: "ROW_TOO_LARGE",
            tableIndex,
            rowIndex: currentRow,
            fileCell: fileCell === "" ? null : fileCell,
            detail: "File 或 Use 单元格超过 16KiB",
          });
          return failure("MAPPING_CELL_TOO_LARGE", warnings, warningCount);
        }
        if (fileCell === "") {
          addWarning({
            code: "EMPTY_FILE",
            tableIndex,
            rowIndex: currentRow,
            fileCell: null,
            detail: "File 为空",
          });
          continue;
        }
        if (usageMarkdown === "" || usageText === "") {
          addWarning({
            code: "EMPTY_USE",
            tableIndex,
            rowIndex: currentRow,
            fileCell,
            detail: "Use 为空",
          });
          continue;
        }
        if (titleRaw !== "" && codePointLength(titleRaw) > 200) {
          addWarning({
            code: "INVALID_TITLE",
            tableIndex,
            rowIndex: currentRow,
            fileCell,
            detail: "Title 超过 200 个 Unicode 码点",
          });
          continue;
        }

        const pathError = filePathWarning(normalizedRelativePath);
        if (pathError !== null) {
          addWarning({
            code: pathError.code,
            tableIndex,
            rowIndex: currentRow,
            fileCell,
            detail: pathError.detail,
          });
          continue;
        }
        const selectedItem = selected.get(normalizedRelativePath);
        if (selectedItem === undefined) {
          addWarning({
            code: "PATH_NOT_SELECTED",
            tableIndex,
            rowIndex: currentRow,
            fileCell,
            detail: "File 不在本次最终选择中",
          });
          continue;
        }
        if (
          selectedItem.kind !== "image" &&
          selectedItem.kind !== "gif" &&
          selectedItem.kind !== "video"
        ) {
          addWarning({
            code: "PATH_NOT_MEDIA",
            tableIndex,
            rowIndex: currentRow,
            fileCell,
            detail: "File 对应的选择项不是媒体",
          });
          continue;
        }

        entries.push({
          mapIndex: input.mapIndex,
          tableIndex,
          rowIndex: currentRow,
          rowKey: `t${tableIndex}:r${currentRow}`,
          sectionHeading,
          fileCell,
          normalizedRelativePath,
          titleText: titleRaw === "" ? null : titleRaw,
          usageMarkdown,
          usageText,
          lineStart: dataLine + 1,
          lineEnd: dataLine + 1,
        });
      }
    }

    if (supportedTableCount === 0) {
      addWarning({
        code: "MAPPING_FORMAT_NOT_FOUND",
        tableIndex: null,
        rowIndex: null,
        fileCell: null,
        detail: "未找到同时包含 File 和 Use 的 Markdown 表格",
      });
      return failure("MAPPING_FORMAT_NOT_FOUND", warnings, warningCount);
    }
    if (entries.length === 0) {
      addWarning({
        code: "MAPPING_EMPTY",
        tableIndex: null,
        rowIndex: null,
        fileCell: null,
        detail: "映射表格没有可应用的条目",
      });
    }
    return { ok: true, entries, warnings, warningCount };
  } catch (error) {
    if (isMappingAbort(error)) {
      return failure(error.errorCode, error.warnings, error.warningCount);
    }
    throw error;
  }
}

function failure(
  errorCode: AssetMapParseErrorCode,
  warnings: AssetMapWarning[],
  warningCount: number,
): AssetMapParseResult {
  return { ok: false, errorCode, warnings, warningCount };
}

function isMappingAbort(value: unknown): value is MappingAbort {
  return (
    typeof value === "object" &&
    value !== null &&
    "errorCode" in value &&
    "warnings" in value &&
    "warningCount" in value
  );
}

function pushHeading(headings: Heading[], level: number, title: string, line: number): void {
  while (headings.length > 0 && (headings.at(-1)?.level ?? 0) >= level) headings.pop();
  headings.push({ level, title, line });
}

function headingPath(headings: Heading[], beforeLine: number): string {
  return headings
    .filter((heading) => heading.line < beforeLine)
    .map((heading) => heading.title)
    .join(" / ");
}

function looksLikeTableRow(line: string): boolean {
  return /^ {0,3}\S/u.test(line) && containsUnescapedPipe(line);
}

function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function containsUnescapedPipe(line: string): boolean {
  let escaped = false;
  let codeRun = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && codeRun === 0) {
      escaped = true;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      if (codeRun === 0) codeRun = run;
      else if (codeRun === run) codeRun = 0;
      index += run - 1;
      continue;
    }
    if (char === "|" && codeRun === 0) return true;
  }
  return false;
}

function splitTableRow(line: string): string[] {
  let source = line.replace(/^ {0,3}/u, "").trimEnd();
  if (source.startsWith("|")) source = source.slice(1);
  if (endsWithUnescapedPipe(source)) source = source.slice(0, -1);
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  let codeRun = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && codeRun === 0) {
      escaped = true;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (source[index + run] === "`") run += 1;
      if (codeRun === 0) codeRun = run;
      else if (codeRun === run) codeRun = 0;
      index += run - 1;
      continue;
    }
    if (char === "|" && codeRun === 0) {
      cells.push(source.slice(start, index));
      start = index + 1;
    }
  }
  cells.push(source.slice(start));
  return cells;
}

function endsWithUnescapedPipe(value: string): boolean {
  if (!value.endsWith("|")) return false;
  let backslashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function normalizeFileCell(fileCell: string): string {
  const unwrapped = unwrapSingleCodeSpan(fileCell.trim());
  const unescaped = unwrapped.replace(/\\([\\`*{}\[\]()#+\-.!_|>~])/gu, "$1");
  return unescaped.replace(/^\.\//u, "");
}

function unwrapSingleCodeSpan(value: string): string {
  const match = /^(`+)([\s\S]*?)\1$/u.exec(value);
  if (match === null) return value;
  const raw = match[2] ?? "";
  if (raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "") return raw.slice(1, -1);
  return raw;
}

function filePathWarning(value: string):
  | { code: "EXTERNAL_PATH" | "ABSOLUTE_PATH" | "OUTSIDE_ROOT"; detail: string }
  | null {
  if (/^https?:/iu.test(value)) {
    return { code: "EXTERNAL_PATH", detail: "不支持外部 URL" };
  }
  if (/^file:/iu.test(value)) {
    return { code: "ABSOLUTE_PATH", detail: "不支持 file URL" };
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    return { code: "ABSOLUTE_PATH", detail: "不支持绝对路径" };
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return { code: "OUTSIDE_ROOT", detail: "路径包含控制字符" };
  }
  if (value.includes("\\")) {
    return { code: "OUTSIDE_ROOT", detail: "路径不能使用反斜杠" };
  }
  if (value.split("/").some((segment) => segment === "..")) {
    return { code: "OUTSIDE_ROOT", detail: "路径包含越界段" };
  }
  if (value.split("/").some((segment) => segment === "")) {
    return { code: "OUTSIDE_ROOT", detail: "路径包含空段" };
  }
  return null;
}

function renderUsageText(markdown: string): string {
  const codeSpans: string[] = [];
  let rendered = markdown.replace(/(`+)([\s\S]*?)\1/gu, (_match, _ticks: string, content: string) => {
    let value = content;
    if (value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "") {
      value = value.slice(1, -1);
    }
    const index = codeSpans.push(value) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  rendered = rendered
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?|mailto):[^>]+)>/giu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/(^|[^\w])\*([^*]+)\*/gu, "$1$2")
    .replace(/(^|[^\w])_([^_]+)_/gu, "$1$2")
    .replace(/\\([\\`*{}\[\]()#+\-.!_|>~])/gu, "$1");
  rendered = rendered.replace(/\u0000CODE(\d+)\u0000/gu, (_match, index: string) => {
    return codeSpans[Number(index)] ?? "";
  });
  return rendered.trim();
}

function codePointLength(value: string): number {
  return [...value].length;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
