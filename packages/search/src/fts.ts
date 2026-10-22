import type Database from "better-sqlite3";
import { z } from "zod";
import { SearchValidationError } from "./errors.js";
import { buildSqlFilterClause, parseHardFilters } from "./filters.js";
import {
  ChunkCandidateSchema,
  ChunkSearchRowSchema,
  HardFiltersSchema,
  KeywordRankedSchema,
  type ChunkSearchRow,
  type HardFilters,
  type KeywordRanked,
} from "./schemas.js";
import {
  excerptForTokens,
  ftsIndexText,
  likePattern,
  normalize,
  normalizeLabel,
  safeFtsQuery,
} from "./tokenize.js";

export const FTS_LIMIT = 50;
export const CHUNK_SEARCH_TABLE = "chunk_search";

const BM25_WEIGHTS = [
  ...Array<number>(18).fill(0),
  10,
  6,
  1,
].join(", ");

const candidateFields = ChunkCandidateSchema.shape;
const FtsQueryRowSchema = z.strictObject({
  chunk_id: candidateFields.refId,
  ref_type: candidateFields.refType,
  source_version_id: candidateFields.sourceVersionId,
  occurrence_id: candidateFields.occurrenceId,
  location_key: candidateFields.locationKey,
  availability: candidateFields.availability,
  media_kind: candidateFields.mediaKind,
  merchant_id: candidateFields.merchantId,
  record_date: candidateFields.recordDate,
  effective_from: candidateFields.effectiveFrom,
  effective_to: candidateFields.effectiveTo,
  obsolete: z.int().min(0).max(1),
  audience_json: z.string(),
  function_json: z.string(),
  title_text: candidateFields.title,
  tags_json: z.string(),
  body_text: candidateFields.text,
  bm25_score: z.number().finite().nullable(),
});

export function ensureChunkSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${CHUNK_SEARCH_TABLE} USING fts5(
      chunk_id UNINDEXED,
      ref_type UNINDEXED,
      source_version_id UNINDEXED,
      occurrence_id UNINDEXED,
      location_key UNINDEXED,
      availability UNINDEXED,
      media_kind UNINDEXED,
      merchant_id UNINDEXED,
      record_date UNINDEXED,
      effective_from UNINDEXED,
      effective_to UNINDEXED,
      obsolete UNINDEXED,
      audience_json UNINDEXED,
      function_json UNINDEXED,
      normalized_text UNINDEXED,
      title_text UNINDEXED,
      tags_json UNINDEXED,
      body_text UNINDEXED,
      title,
      tags,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

export function replaceChunkSearchRows(
  db: Database.Database,
  rows: readonly ChunkSearchRow[],
): void {
  const parsed = rows.map((row) => ChunkSearchRowSchema.parse(row));
  const replace = db.transaction((items: readonly ChunkSearchRow[]) => {
    const remove = db.prepare(`DELETE FROM ${CHUNK_SEARCH_TABLE} WHERE chunk_id = ?`);
    const insert = db.prepare(`
      INSERT INTO ${CHUNK_SEARCH_TABLE} (
        chunk_id, ref_type, source_version_id, occurrence_id, location_key,
        availability, media_kind, merchant_id, record_date, effective_from,
        effective_to, obsolete, audience_json, function_json, normalized_text,
        title_text, tags_json, body_text, title, tags, body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of items) {
      remove.run(row.chunkId);
      insert.run(
        row.chunkId,
        row.refType,
        row.sourceVersionId,
        row.occurrenceId,
        row.locationKey,
        row.availability,
        row.mediaKind,
        row.merchantId?.toLowerCase() ?? null,
        row.recordDate,
        row.effectiveFrom,
        row.effectiveTo,
        row.obsolete ? 1 : 0,
        JSON.stringify(row.audience.map(normalizeLabel)),
        JSON.stringify(row.functions.map(normalizeLabel)),
        normalize([row.title, ...row.tags, row.body].join(" ")),
        row.title,
        JSON.stringify(row.tags),
        row.body,
        ftsIndexText(row.title),
        row.tags.map((tag) => ftsIndexText(tag)).join(" "),
        ftsIndexText(row.body),
      );
    }
  });
  replace(parsed);
}

function parseStringArray(value: string): string[] {
  return z.array(z.string()).parse(JSON.parse(value));
}

function rowToCandidate(row: z.infer<typeof FtsQueryRowSchema>) {
  return ChunkCandidateSchema.parse({
    schemaVersion: 1,
    refId: row.chunk_id,
    refType: row.ref_type,
    occurrenceId: row.occurrence_id,
    sourceVersionId: row.source_version_id,
    title: row.title_text,
    text: row.body_text,
    tags: parseStringArray(row.tags_json),
    merchantId: row.merchant_id,
    mediaKind: row.media_kind,
    recordDate: row.record_date,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    audience: parseStringArray(row.audience_json),
    functions: parseStringArray(row.function_json),
    obsolete: row.obsolete === 1,
    availability: row.availability,
    locationKey: row.location_key,
  });
}

function hitReason(row: z.infer<typeof FtsQueryRowSchema>, tokens: readonly string[]): string {
  const title = normalize(row.title_text);
  const tags = normalize(row.tags_json);
  const body = normalize(row.body_text);
  const fields: string[] = [];
  if (tokens.some((token) => title.includes(token))) fields.push("标题");
  if (tokens.some((token) => tags.includes(token))) fields.push("标签");
  if (tokens.some((token) => body.includes(token))) fields.push("正文");
  return `关键词命中${fields.length === 0 ? "索引" : fields.join("/")}；BM25 权重 标题10 标签6 正文1`;
}

export function searchChunks(
  db: Database.Database,
  query: string,
  filtersInput: unknown,
  requestedLimit = FTS_LIMIT,
): KeywordRanked[] {
  const filters = parseHardFilters(filtersInput);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new SearchValidationError("INVALID_QUERY", "limit 必须是正整数");
  }
  const limit = Math.min(requestedLimit, FTS_LIMIT);
  const safeQuery = safeFtsQuery(query);
  const filterClause = buildSqlFilterClause(filters);
  const whereParts: string[] = [];
  const params: Array<string | number> = [];
  const orderParams: string[] = [];

  if (safeQuery.ftsExpression !== null) {
    whereParts.push(`${CHUNK_SEARCH_TABLE} MATCH ?`);
    params.push(safeQuery.ftsExpression);
  }
  whereParts.push(`(${filterClause.sql})`);
  params.push(...filterClause.params);
  for (const term of safeQuery.likeTerms) {
    whereParts.push("normalized_text LIKE ? ESCAPE '\\'");
    params.push(likePattern(term));
  }

  let orderBy: string;
  let scoreSelect: string;
  if (safeQuery.ftsExpression === null) {
    orderBy = "instr(normalized_text, ?) ASC, length(normalized_text) ASC, chunk_id ASC";
    orderParams.push(safeQuery.likeTerms[0] ?? "");
    scoreSelect = "NULL AS bm25_score";
  } else {
    orderBy = `bm25(${CHUNK_SEARCH_TABLE}, ${BM25_WEIGHTS}) ASC, chunk_id ASC`;
    scoreSelect = `bm25(${CHUNK_SEARCH_TABLE}, ${BM25_WEIGHTS}) AS bm25_score`;
  }

  const sql = `
    SELECT
      chunk_id, ref_type, source_version_id, occurrence_id, location_key,
      availability, media_kind, merchant_id, record_date, effective_from,
      effective_to, obsolete, audience_json, function_json, title_text,
      tags_json, body_text, ${scoreSelect}
    FROM ${CHUNK_SEARCH_TABLE}
    WHERE ${whereParts.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;
  const rawRows: unknown[] = db.prepare(sql).all(...params, ...orderParams);
  const tokens = [...safeQuery.ftsTokens, ...safeQuery.likeTerms];

  return rawRows.map((raw, index) => {
    const row = FtsQueryRowSchema.parse(raw);
    return KeywordRankedSchema.parse({
      schemaVersion: 1,
      candidate: rowToCandidate(row),
      keywordRank: index + 1,
      matchedText: excerptForTokens(row.body_text, tokens),
      reason: hitReason(row, tokens),
    });
  });
}

export function parseFtsFilters(input: unknown): HardFilters {
  return HardFiltersSchema.parse(input);
}
