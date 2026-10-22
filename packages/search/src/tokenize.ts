import { z } from "zod";
import { SearchValidationError } from "./errors.js";

const HAN_CHARACTER = /\p{Script=Han}/u;
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

export const FtsTokenSchema = z.strictObject({
  kind: z.enum(["cjk_bigram", "cjk_single", "latin_word"]),
  value: z.string().min(1),
});
export type FtsToken = z.infer<typeof FtsTokenSchema>;

export const SafeFtsQuerySchema = z.strictObject({
  schemaVersion: z.literal(1),
  normalizedQuery: z.string().min(1),
  mode: z.enum(["fts", "like", "mixed"]),
  ftsExpression: z.string().min(1).nullable(),
  ftsTokens: z.array(z.string().min(1)),
  likeTerms: z.array(z.string().min(1)),
});
export type SafeFtsQuery = z.infer<typeof SafeFtsQuerySchema>;

export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function normalizeLabel(value: string): string {
  return normalize(value);
}

export function tokenizeForFts(value: string): FtsToken[] {
  const normalized = normalize(value);
  const tokens: FtsToken[] = [];
  let word = "";
  let hanRun = "";

  const flushWord = (): void => {
    if (word.length > 0) {
      tokens.push({ kind: "latin_word", value: word });
      word = "";
    }
  };

  const flushHan = (): void => {
    if (hanRun.length === 0) return;
    const characters = Array.from(hanRun);
    if (characters.length === 1) {
      const only = characters[0];
      if (only !== undefined) tokens.push({ kind: "cjk_single", value: only });
    } else {
      for (let index = 0; index < characters.length - 1; index += 1) {
        const left = characters[index];
        const right = characters[index + 1];
        if (left !== undefined && right !== undefined) {
          tokens.push({ kind: "cjk_bigram", value: `${left}${right}` });
        }
      }
    }
    hanRun = "";
  };

  for (const character of normalized) {
    if (HAN_CHARACTER.test(character)) {
      flushWord();
      hanRun += character;
      continue;
    }
    flushHan();
    if (WORD_CHARACTER.test(character)) {
      word += character;
    } else {
      flushWord();
    }
  }
  flushHan();
  flushWord();

  return tokens;
}

export function ftsIndexText(value: string): string {
  return tokenizeForFts(value)
    .map((token) => token.value)
    .join(" ");
}

export function escapeLikePattern(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/%/gu, "\\%").replace(/_/gu, "\\_");
}

export function likePattern(value: string): string {
  return `%${escapeLikePattern(normalize(value))}%`;
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/gu, '""')}"`;
}

export function safeFtsQuery(query: string): SafeFtsQuery {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length === 0) {
    throw new SearchValidationError("INVALID_QUERY", "查询不能为空");
  }

  const tokens = tokenizeForFts(normalizedQuery);
  const ftsTokens = [
    ...new Set(tokens.filter((token) => token.kind !== "cjk_single").map((token) => token.value)),
  ];
  const likeTerms = [
    ...new Set(tokens.filter((token) => token.kind === "cjk_single").map((token) => token.value)),
  ];

  if (ftsTokens.length === 0 && likeTerms.length === 0) {
    throw new SearchValidationError("INVALID_QUERY", "查询没有可检索的文字或数字");
  }

  const ftsExpression =
    ftsTokens.length === 0 ? null : ftsTokens.map(quoteFtsToken).join(" AND ");
  const mode =
    ftsExpression === null ? "like" : likeTerms.length > 0 ? "mixed" : "fts";

  return SafeFtsQuerySchema.parse({
    schemaVersion: 1,
    normalizedQuery,
    mode,
    ftsExpression,
    ftsTokens,
    likeTerms,
  });
}

export function excerptForTokens(value: string, tokens: readonly string[], length = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= length) return compact;
  const normalized = normalize(compact);
  const positions = tokens
    .map((token) => normalized.indexOf(token))
    .filter((position) => position >= 0);
  const first = positions.length === 0 ? 0 : Math.min(...positions);
  const firstCharacter = Array.from(normalized.slice(0, first)).length;
  const start = Math.max(0, Math.min(firstCharacter - Math.floor(length / 3), characters.length - length));
  return characters.slice(start, start + length).join("");
}
