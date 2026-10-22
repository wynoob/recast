import { z } from "zod";
import {
  SchemaVersionSchema,
  SelectionHandleSchema,
  UuidSchema,
} from "./ids.js";
import { LocatorSchema } from "./locators.js";
import { DocumentBlockViewSchema, DocumentSectionViewSchema } from "./documents.js";
import { FactEntitySchema } from "./facts.js";
import { HardFiltersSchema } from "./search-filters.js";

export const SearchRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  query: z.string().trim().min(1).max(500),
  filters: HardFiltersSchema,
  limit: z.int().min(1).max(20).default(20),
  mode: z.enum(["keyword", "hybrid"]).default("keyword"),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z.strictObject({
  refId: UuidSchema,
  refType: z.enum(["source_version", "fact"]),
  chunkId: UuidSchema,
  sourceId: UuidSchema.nullable(),
  sourceVersionId: UuidSchema.nullable(),
  sourceTitle: z.string().nullable(),
  sourceKind: z.string().nullable(),
  occurrenceId: UuidSchema.nullable(),
  factId: UuidSchema.nullable(),
  factVersionId: UuidSchema.nullable(),
  matchedText: z.string(),
  reason: z.string(),
  keywordRank: z.int().positive().nullable(),
  semanticRank: z.int().positive().nullable(),
  availability: z.enum(["available", "missing", "unsupported"]),
  score: z.number().finite().nonnegative(),
  scoreKind: z.literal("rrf_k60"),
  locators: z.array(LocatorSchema),
  blockIds: z.array(UuidSchema),
  selectionHandle: SelectionHandleSchema,
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchCapabilitiesSchema = z.strictObject({
  keyword: z.literal("available"),
  semantic: z.literal("unavailable"),
  mode: z.literal("keyword_only"),
  message: z.string().min(1),
});
export type SearchCapabilities = z.infer<typeof SearchCapabilitiesSchema>;

export const SearchResponseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  indexGenerationId: UuidSchema,
  capabilities: SearchCapabilitiesSchema,
  filters: HardFiltersSchema,
  hits: z.array(SearchHitSchema).max(20),
  total: z.int().nonnegative(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const SelectionViewSchema = z.strictObject({
  id: SelectionHandleSchema,
  indexGenerationId: UuidSchema,
  refId: UuidSchema,
  refType: z.enum(["source_version", "fact"]),
  chunkId: UuidSchema,
  sourceId: UuidSchema.nullable(),
  sourceVersionId: UuidSchema.nullable(),
  sourceTitle: z.string().nullable(),
  occurrenceId: UuidSchema.nullable(),
  section: DocumentSectionViewSchema.nullable(),
  blocks: z.array(DocumentBlockViewSchema),
  locators: z.array(LocatorSchema),
  fact: FactEntitySchema.nullable(),
  sourceFileUrl: z.string().nullable(),
  sourceDocumentUrl: z.string().nullable(),
});
export type SelectionView = z.infer<typeof SelectionViewSchema>;
