import {
  AiFilterHintSchema,
  ChunkCandidateSchema,
  HardFiltersSchema,
  type AiFilterHint,
  type ChunkCandidate,
  type HardFilters,
} from "./schemas.js";
import { normalizeLabel } from "./tokenize.js";

type SqlValue = string | number;

export interface SqlFilterClause {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export function parseHardFilters(input: unknown): HardFilters {
  return HardFiltersSchema.parse(input);
}

export function parseAiFilterHints(input: unknown): AiFilterHint[] {
  return input === undefined ? [] : AiFilterHintSchema.array().parse(input);
}

export function presentAiFilterHints(input: unknown): AiFilterHint[] {
  return parseAiFilterHints(input).map((hint) => ({ ...hint, removable: true }));
}

function dateEvidence(candidate: ChunkCandidate): readonly [string, string] | null {
  if (candidate.recordDate !== null) return [candidate.recordDate, candidate.recordDate];
  if (candidate.effectiveFrom === null && candidate.effectiveTo === null) return null;
  return [candidate.effectiveFrom ?? "0000-01-01", candidate.effectiveTo ?? "9999-12-31"];
}

function matchesDateRange(candidate: ChunkCandidate, filters: HardFilters): boolean {
  if (filters.dateFrom === null && filters.dateTo === null) return true;
  const evidence = dateEvidence(candidate);
  if (evidence === null) return false;
  const lower = filters.dateFrom ?? "0000-01-01";
  const upper = filters.dateTo ?? "9999-12-31";
  return evidence[0] <= upper && evidence[1] >= lower;
}

function includesAllLabels(actual: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) return true;
  const values = new Set(actual.map(normalizeLabel));
  return required.every((label) => values.has(normalizeLabel(label)));
}

export function matchesHardFilters(candidate: ChunkCandidate, filters: HardFilters): boolean {
  if (
    filters.merchantId !== null &&
    (candidate.merchantId === null ||
      candidate.merchantId.toLowerCase() !== filters.merchantId.toLowerCase())
  ) {
    return false;
  }
  if (!matchesDateRange(candidate, filters)) return false;
  if (filters.mediaKinds.length > 0 && !filters.mediaKinds.includes(candidate.mediaKind)) {
    return false;
  }
  if (!includesAllLabels(candidate.audience, filters.audience)) return false;
  if (!includesAllLabels(candidate.functions, filters.functions)) return false;
  if (filters.obsolete === "exclude" && candidate.obsolete) return false;
  if (filters.obsolete === "only" && !candidate.obsolete) return false;
  if (
    filters.availability.length > 0 &&
    !filters.availability.includes(candidate.availability)
  ) {
    return false;
  }
  return true;
}

export function filterCandidates(
  candidates: readonly ChunkCandidate[],
  filters: HardFilters,
): ChunkCandidate[] {
  const parsedFilters = HardFiltersSchema.parse(filters);
  return candidates
    .map((candidate) => ChunkCandidateSchema.parse(candidate))
    .filter((candidate) => matchesHardFilters(candidate, parsedFilters));
}

export function buildSqlFilterClause(filters: HardFilters): SqlFilterClause {
  const parsed = HardFiltersSchema.parse(filters);
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (parsed.merchantId !== null) {
    clauses.push("merchant_id = ?");
    params.push(parsed.merchantId.toLowerCase());
  }

  if (parsed.dateFrom !== null || parsed.dateTo !== null) {
    const lower = parsed.dateFrom ?? "0000-01-01";
    const upper = parsed.dateTo ?? "9999-12-31";
    clauses.push(`(
      (record_date IS NOT NULL AND record_date >= ? AND record_date <= ?)
      OR
      (
        record_date IS NULL
        AND (effective_from IS NOT NULL OR effective_to IS NOT NULL)
        AND (effective_from IS NULL OR effective_from <= ?)
        AND (effective_to IS NULL OR effective_to >= ?)
      )
    )`);
    params.push(lower, upper, upper, lower);
  }

  if (parsed.mediaKinds.length > 0) {
    clauses.push(`media_kind IN (${parsed.mediaKinds.map(() => "?").join(", ")})`);
    params.push(...parsed.mediaKinds);
  }

  for (const audience of parsed.audience) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(chunk_search.audience_json) WHERE lower(value) = ?)",
    );
    params.push(normalizeLabel(audience));
  }

  for (const functionName of parsed.functions) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(chunk_search.function_json) WHERE lower(value) = ?)",
    );
    params.push(normalizeLabel(functionName));
  }

  if (parsed.obsolete === "exclude") clauses.push("obsolete = 0");
  if (parsed.obsolete === "only") clauses.push("obsolete = 1");

  if (parsed.availability.length > 0) {
    clauses.push(`availability IN (${parsed.availability.map(() => "?").join(", ")})`);
    params.push(...parsed.availability);
  }

  return {
    sql: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "),
    params,
  };
}
