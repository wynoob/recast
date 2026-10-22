import { createHash } from "node:crypto";
import { SearchValidationError } from "./errors.js";
import {
  CHUNK_HARD_MAX,
  ChunkDraftSchema,
  ChunkSectionInputSchema,
  ChunkSectionsInputSchema,
  type ChunkBlockInput,
  type ChunkDraft,
  type ChunkSectionInput,
  type RefType,
} from "./schemas.js";

export const CHUNK_TARGET_MIN = 300;
export const CHUNK_TARGET_MAX = 800;
export { CHUNK_HARD_MAX } from "./schemas.js";
export const CHUNK_OVERLAP_MAX = 100;

export interface ChunkOptions {
  readonly makeChunkRefId?: (seedHash: string) => string;
}

interface EmitInput {
  readonly section: ChunkSectionInput;
  readonly body: string;
  readonly chunkKind: "text" | "table" | "image_context" | "fact";
  readonly blockIds: readonly string[];
  readonly occurrenceId: string | null;
  readonly overlapChars: number;
  readonly locationKey: string;
  readonly refType: RefType;
  readonly refId: string | null;
  readonly includeHeading?: boolean;
}

interface SplitPiece {
  readonly text: string;
  readonly overlapChars: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cellsToLine(cells: readonly string[]): string {
  return cells.map((cell) => cell.replace(/\s+/gu, " ").trim()).join(" | ");
}

interface TextFragment {
  readonly text: string;
  readonly blockId: string | null;
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

function fragmentText(fragments: readonly TextFragment[]): string {
  return fragments.map((fragment) => fragment.text).join("");
}

function sliceFragments(fragments: readonly TextFragment[], start: number, end: number): TextFragment[] {
  const result: TextFragment[] = [];
  let offset = 0;
  for (const fragment of fragments) {
    const characters = Array.from(fragment.text);
    const text = characters.slice(Math.max(0, start - offset), Math.max(0, end - offset)).join("");
    if (text.length > 0) result.push({ text, blockId: fragment.blockId });
    offset += characters.length;
    if (offset >= end) break;
  }
  return result;
}

function trimFragments(fragments: readonly TextFragment[]): TextFragment[] {
  const text = fragmentText(fragments);
  const start = characterCount(text) - characterCount(text.trimStart());
  return sliceFragments(fragments, start, start + characterCount(text.trim()));
}

function fragmentBlockIds(fragments: readonly TextFragment[]): string[] {
  return [...new Set(fragments.flatMap((fragment) => fragment.blockId === null ? [] : [fragment.blockId]))];
}

function splitLongText(text: string, limit: number, overlap: number): SplitPiece[] {
  if (limit <= overlap + 20) {
    throw new SearchValidationError("CHUNK_INPUT_INVALID", "可用 chunk 长度过小");
  }
  const characters = Array.from(text);
  if (characters.length <= limit) return [{ text, overlapChars: 0 }];

  const pieces: SplitPiece[] = [];
  const boundaryPattern = /[。！？!?；;\n]/u;
  let start = 0;
  let previousEnd = 0;
  while (start < characters.length) {
    const hardEnd = Math.min(start + limit, characters.length);
    let end = hardEnd;
    if (hardEnd < characters.length) {
      const minimumCut = start + Math.floor(limit * 0.55);
      for (let index = hardEnd - 1; index >= minimumCut; index -= 1) {
        if (boundaryPattern.test(characters[index] ?? "")) {
          end = index + 1;
          break;
        }
      }
    }
    pieces.push({
      text: characters.slice(start, end).join(""),
      overlapChars: Math.max(0, Math.min(overlap, previousEnd - start)),
    });
    previousEnd = end;
    if (end >= characters.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return pieces;
}

function tailOverlap(previous: readonly TextFragment[], maximum: number): TextFragment[] {
  if (maximum <= 0) return [];
  const characters = Array.from(fragmentText(previous));
  let start = Math.max(0, characters.length - maximum);
  for (let index = characters.length - 2; index >= start; index -= 1) {
    if (/[。！？!?；;]/u.test(characters[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  return trimFragments(sliceFragments(previous, start, characters.length));
}

export function chunkSections(input: unknown, options: ChunkOptions = {}): ChunkDraft[] {
  const sections = ChunkSectionsInputSchema.parse(input);
  const drafts: ChunkDraft[] = [];

  for (const section of sections) {
    drafts.push(...chunkSection(section, options));
  }
  return drafts;
}

function chunkSection(section: ChunkSectionInput, options: ChunkOptions): ChunkDraft[] {
  const headingPrefix = `${section.title}\n\n`;
  if (characterCount(headingPrefix) >= CHUNK_HARD_MAX - 50) {
    throw new SearchValidationError("CHUNK_INPUT_INVALID", "章节标题过长，无法形成有效 chunk");
  }
  const bodyLimit = CHUNK_HARD_MAX - characterCount(headingPrefix);
  const targetMax = Math.max(100, Math.min(CHUNK_TARGET_MAX - characterCount(headingPrefix), bodyLimit));

  const drafts: ChunkDraft[] = [];
  let current: TextFragment[] = [];
  let currentOverlap = 0;
  let previous: TextFragment[] = [];
  let locationIndex = 0;

  const scope =
    section.page === null ? `section:${section.sectionId}` : `page:${section.page}`;

  const emit = (input: EmitInput): void => {
    const text =
      input.refType === "fact" || input.includeHeading === false
        ? input.body
        : `${headingPrefix}${input.body}`;
    const contentHash = sha256(text);
    const idSeed = sha256(
      `${section.sourceVersionId}|${section.sectionId}|${input.locationKey}|${contentHash}`,
    );
    const refId =
      input.refId ??
      (options.makeChunkRefId === undefined
        ? `chunk_${idSeed.slice(0, 40)}`
        : options.makeChunkRefId(idSeed));
    const candidate = {
      schemaVersion: 1 as const,
      refId,
      refType: input.refType,
      occurrenceId: input.occurrenceId,
      sourceVersionId: section.sourceVersionId,
      title: section.title,
      text,
      tags: section.tags,
      merchantId: section.metadata.merchantId,
      mediaKind: section.metadata.mediaKind,
      recordDate: section.metadata.recordDate,
      effectiveFrom: section.metadata.effectiveFrom,
      effectiveTo: section.metadata.effectiveTo,
      audience: section.metadata.audience,
      functions: section.metadata.functions,
      obsolete: section.metadata.obsolete,
      availability: section.metadata.availability,
      locationKey: input.locationKey,
    };
    drafts.push(
      ChunkDraftSchema.parse({
        schemaVersion: 1,
        sectionId: section.sectionId,
        candidate,
        chunkKind: input.chunkKind,
        contentHash,
        blockIds: [...new Set(input.blockIds)],
        overlapChars: input.overlapChars,
      }),
    );
  };

  const flushText = (): void => {
    const fragments = trimFragments(current);
    const body = fragmentText(fragments);
    if (body.length > 0) {
      emit({
        section,
        body,
        chunkKind: "text",
        blockIds: fragmentBlockIds(fragments),
        occurrenceId: null,
        overlapChars: currentOverlap,
        locationKey: `${scope}:${section.sectionId}:text:${locationIndex}`,
        refType: "chunk",
        refId: null,
      });
      locationIndex += 1;
      previous = fragments;
    }
    current = [];
    currentOverlap = 0;
  };

  const startText = (piece: string, blockId: string): void => {
    const available = targetMax - characterCount(piece) - 1;
    const overlap = tailOverlap(previous, Math.min(CHUNK_OVERLAP_MAX, available));
    currentOverlap = characterCount(fragmentText(overlap));
    current = [...overlap];
    if (currentOverlap > 0) current.push({ text: "\n", blockId: null });
    current.push({ text: piece, blockId });
  };

  const appendTextBlock = (blockId: string, text: string): void => {
    const paragraphs = text
      .split(/\n{2,}/u)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    for (const paragraph of paragraphs) {
      if (characterCount(paragraph) > targetMax) {
        flushText();
        for (const piece of splitLongText(paragraph, targetMax, CHUNK_OVERLAP_MAX)) {
          emit({
            section,
            body: piece.text,
            chunkKind: "text",
            blockIds: [blockId],
            occurrenceId: null,
            overlapChars: piece.overlapChars,
            locationKey: `${scope}:${section.sectionId}:text:${locationIndex}`,
            refType: "chunk",
            refId: null,
          });
          locationIndex += 1;
          previous = [{ text: piece.text, blockId }];
        }
        continue;
      }

      if (current.length === 0) {
        startText(paragraph, blockId);
        continue;
      }

      const combinedLength = characterCount(fragmentText(current)) + 2 + characterCount(paragraph);
      if (combinedLength <= targetMax) {
        current.push({ text: "\n\n", blockId: null }, { text: paragraph, blockId });
        continue;
      }

      flushText();
      startText(paragraph, blockId);
    }
  };

  const chunkTable = (block: Extract<ChunkBlockInput, { kind: "table" }>): void => {
    flushText();
    previous = [];
    const header = cellsToLine(block.columns);
    const tablePrefix = `表格 ${block.blockId}\n${header}\n`;
    if (characterCount(tablePrefix) >= bodyLimit - 50) {
      throw new SearchValidationError("CHUNK_INPUT_INVALID", "表格表头过宽，无法保留表头切分");
    }
    const available = bodyLimit - characterCount(tablePrefix);
    const lines = block.rows.map(cellsToLine);
    const groups: string[] = [];
    let group = "";

    const flushGroup = (): void => {
      if (group.length === 0) return;
      groups.push(group);
      group = "";
    };

    for (const line of lines) {
      if (characterCount(line) > available) {
        flushGroup();
        for (const piece of splitLongText(line, Math.max(20, available - 4), 0)) {
          groups.push(`${piece.text}（行续）`);
        }
        continue;
      }
      const combined = group.length === 0 ? line : `${group}\n${line}`;
      if (characterCount(combined) > available) {
        flushGroup();
        group = line;
      } else {
        group = combined;
      }
    }
    flushGroup();
    if (groups.length === 0) groups.push("（空表）");

    for (const [index, groupText] of groups.entries()) {
      emit({
        section,
        body: `${tablePrefix}${groupText}`,
        chunkKind: "table",
        blockIds: [block.blockId],
        occurrenceId: null,
        overlapChars: 0,
        locationKey: `${scope}:${section.sectionId}:table:${block.blockId}:${index}`,
        refType: "chunk",
        refId: null,
      });
    }
  };

  const chunkImageContext = (
    block: Extract<ChunkBlockInput, { kind: "image_context" }>,
  ): void => {
    flushText();
    previous = [];
    const pieces = splitLongText(block.text, targetMax, 0);
    pieces.forEach((piece, index) => {
      emit({
        section,
        body: piece.text,
        chunkKind: "image_context",
        blockIds: [block.blockId],
        occurrenceId: block.occurrenceId,
        overlapChars: 0,
        locationKey: `${scope}:${section.sectionId}:image:${block.occurrenceId}:${block.blockId}:${index}`,
        refType: "chunk",
        refId: null,
      });
    });
  };

  const chunkFact = (block: Extract<ChunkBlockInput, { kind: "fact" }>): void => {
    flushText();
    previous = [];
    emit({
      section,
      body: block.text,
      chunkKind: "fact",
      blockIds: [block.blockId],
      occurrenceId: null,
      overlapChars: 0,
      locationKey: block.locatorKey ?? `fact:${block.refId}`,
      refType: "fact",
      refId: block.refId,
    });
  };

  for (const block of section.blocks) {
    switch (block.kind) {
      case "text":
        appendTextBlock(block.blockId, block.text);
        break;
      case "table":
        chunkTable(block);
        break;
      case "image_context":
        chunkImageContext(block);
        break;
      case "fact":
        chunkFact(block);
        break;
    }
  }
  if (section.blocks.length === 0) {
    emit({
      section,
      body: section.title,
      chunkKind: "text",
      blockIds: [],
      occurrenceId: null,
      overlapChars: 0,
      locationKey: `${scope}:${section.sectionId}:title`,
      refType: "chunk",
      refId: null,
      includeHeading: false,
    });
  }
  flushText();
  return drafts;
}

export function parseChunkSection(input: unknown): ChunkSectionInput {
  return ChunkSectionInputSchema.parse(input);
}
