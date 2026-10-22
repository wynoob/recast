import type Database from "better-sqlite3";
import { searchChunks } from "./fts.js";
import { rrfMerge } from "./ranking.js";
import type { RrfOutcome } from "./schemas.js";

export * from "./chunks.js";
export * from "./errors.js";
export * from "./filters.js";
export * from "./fts.js";
export * from "./namespace.js";
export * from "./ranking.js";
export * from "./schemas.js";
export * from "./tokenize.js";

export const SEARCH_CONTRACT_VERSION = 1;

export function searchKeywordOnly(
  db: Database.Database,
  query: string,
  filters: unknown,
  reason = "embedding 服务不可用，降级为关键词检索",
): RrfOutcome {
  return rrfMerge({
    keyword: searchChunks(db, query, filters),
    semantic: [],
    semanticState: {
      status: "unavailable",
      code: "EMBEDDING_UNAVAILABLE",
      message: reason,
    },
  });
}
