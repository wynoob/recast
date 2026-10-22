import { z } from "zod";
import { normalizeLabel } from "./tokenize.js";
import {
  HardFiltersSchema,
  ObsoleteFilterSchema,
  SearchAvailabilitySchema,
  SearchMediaKindSchema,
  type HardFilters,
  type ObsoleteFilter,
  type SearchAvailability,
  type SearchMediaKind,
} from "@dmall/contracts";

export const SchemaVersionSchema = z.literal(1);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const IsoDateSchema = z.iso.date();
const UnicodeTextSchema = z.string().refine(
  (value) => !/[\uD800-\uDFFF]/u.test(value),
  "文本不能包含孤立代理项",
);

export const CHUNK_HARD_MAX = 1_200;
export const IndexTextSchema = UnicodeTextSchema.superRefine((value, context) => {
  const actualCodePoints = Array.from(value).length;
  if (actualCodePoints > CHUNK_HARD_MAX) {
    context.addIssue({
      code: "custom",
      message: `索引文本不能超过 ${CHUNK_HARD_MAX} 个 Unicode 码点`,
      params: { code: "INDEX_TEXT_TOO_LONG", maxCodePoints: CHUNK_HARD_MAX, actualCodePoints },
    });
  }
});

export const MediaKindSchema = SearchMediaKindSchema;
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const AvailabilitySchema = SearchAvailabilitySchema;
export type Availability = z.infer<typeof AvailabilitySchema>;

export const RefTypeSchema = z.enum(["chunk", "fact"]);
export type RefType = z.infer<typeof RefTypeSchema>;

export { HardFiltersSchema, ObsoleteFilterSchema };
export type { HardFilters, ObsoleteFilter, SearchAvailability, SearchMediaKind };

const EffectiveDatesSchema = z.strictObject({
  effectiveFrom: IsoDateSchema.nullable(),
  effectiveTo: IsoDateSchema.nullable(),
});
function hasOrderedEffectiveDates(value: z.infer<typeof EffectiveDatesSchema>): boolean {
  return value.effectiveFrom === null || value.effectiveTo === null || value.effectiveFrom <= value.effectiveTo;
}
const effectiveDatesMessage = "effectiveFrom 不能晚于 effectiveTo";
const FilterLabelSchema = UnicodeTextSchema.min(1).max(100).refine(
  (value) => {
    const normalized = normalizeLabel(value);
    return normalized.length > 0 && normalized.length <= 100;
  },
  "筛选标签归一化后必须为 1-100 字符",
);
const ChunkCandidateFieldsSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    refId: UnicodeTextSchema.min(1).max(512),
    refType: RefTypeSchema,
    occurrenceId: z.uuid().nullable(),
    sourceVersionId: z.uuid(),
    title: UnicodeTextSchema.max(500),
    text: IndexTextSchema,
    tags: z.array(UnicodeTextSchema.min(1).max(200)).max(200),
    merchantId: z.uuid().nullable(),
    mediaKind: MediaKindSchema,
    recordDate: IsoDateSchema.nullable(),
    ...EffectiveDatesSchema.shape,
    audience: z.array(FilterLabelSchema).max(100),
    functions: z.array(FilterLabelSchema).max(100),
    obsolete: z.boolean(),
    availability: AvailabilitySchema,
    locationKey: UnicodeTextSchema.min(1).max(512),
  });
export const ChunkCandidateSchema = ChunkCandidateFieldsSchema.refine(
  hasOrderedEffectiveDates, effectiveDatesMessage,
);
export type ChunkCandidate = z.infer<typeof ChunkCandidateSchema>;

export const EmbeddingNamespaceSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  preprocessingVersion: z.string().min(1).max(100),
  dimension: z.int().positive().max(65_536),
  fingerprint: Sha256Schema,
});
export type EmbeddingNamespace = z.infer<typeof EmbeddingNamespaceSchema>;

export const EmbeddingNamespaceSeedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  preprocessingVersion: z.string().min(1).max(100),
  dimension: z.int().positive().max(65_536),
});
export type EmbeddingNamespaceSeed = z.infer<typeof EmbeddingNamespaceSeedSchema>;

export const RankedHitSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  refId: UnicodeTextSchema.min(1).max(512),
  refType: RefTypeSchema,
  occurrenceId: z.uuid().nullable(),
  sourceVersionId: z.uuid(),
  matchedText: z.string(),
  reason: z.string().min(1),
  keywordRank: z.int().positive().nullable(),
  semanticRank: z.int().positive().nullable(),
  availability: AvailabilitySchema,
  score: z.number().finite().nonnegative(),
  scoreKind: z.literal("rrf_k60"),
  locationKey: UnicodeTextSchema.min(1).max(512),
});
export type RankedHit = z.infer<typeof RankedHitSchema>;

export const KeywordRankedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  candidate: ChunkCandidateSchema,
  keywordRank: z.int().positive(),
  matchedText: z.string(),
  reason: z.string().min(1),
});
export type KeywordRanked = z.infer<typeof KeywordRankedSchema>;

export const SemanticRankedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  candidate: ChunkCandidateSchema,
  semanticRank: z.int().positive(),
  score: z.number().finite().min(-1).max(1),
  matchedText: z.string(),
  reason: z.string().min(1),
});
export type SemanticRanked = z.infer<typeof SemanticRankedSchema>;

export const EmbeddingRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  candidate: ChunkCandidateSchema,
  namespace: EmbeddingNamespaceSchema,
  vector: z.array(z.number().finite()).min(1),
});
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>;

export const SemanticStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.enum(["EMBEDDING_UNAVAILABLE", "EMBEDDING_INVALID"]),
    message: z.string().min(1),
  }),
]);
export type SemanticState = z.infer<typeof SemanticStateSchema>;

export const RrfOutcomeSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  mode: z.enum(["hybrid", "keyword_only"]),
  degradation: z
    .strictObject({
      code: z.enum(["EMBEDDING_UNAVAILABLE", "EMBEDDING_INVALID"]),
      message: z.string().min(1),
    })
    .nullable(),
  hits: z.array(RankedHitSchema).max(20),
});
export type RrfOutcome = z.infer<typeof RrfOutcomeSchema>;

const AiFilterHintBase = {
  schemaVersion: SchemaVersionSchema,
  source: z.literal("ai"),
  removable: z.literal(true),
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().min(1).max(500),
};

export const AiFilterHintSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...AiFilterHintBase,
    kind: z.literal("merchant"),
    merchantId: z.uuid(),
  }),
  z.strictObject({
    ...AiFilterHintBase,
    kind: z.literal("date"),
    dateFrom: IsoDateSchema.nullable(),
    dateTo: IsoDateSchema.nullable(),
  }),
  z.strictObject({
    ...AiFilterHintBase,
    kind: z.literal("media"),
    mediaKind: MediaKindSchema,
  }),
  z.strictObject({
    ...AiFilterHintBase,
    kind: z.literal("audience"),
    audience: z.string().min(1).max(100),
  }),
  z.strictObject({
    ...AiFilterHintBase,
    kind: z.literal("function"),
    functionName: z.string().min(1).max(100),
  }),
  z.strictObject({
    ...AiFilterHintBase,
    kind: z.literal("obsolete"),
    obsolete: z.boolean(),
  }),
]);
export type AiFilterHint = z.infer<typeof AiFilterHintSchema>;

export const ChunkSectionMetadataSchema = ChunkCandidateFieldsSchema.pick({
  merchantId: true, mediaKind: true, recordDate: true,
  effectiveFrom: true, effectiveTo: true, audience: true, functions: true,
  obsolete: true, availability: true,
}).refine(hasOrderedEffectiveDates, effectiveDatesMessage);
export type ChunkSectionMetadata = z.infer<typeof ChunkSectionMetadataSchema>;

export const ChunkBlockInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    blockId: UnicodeTextSchema.min(1).max(512),
    text: UnicodeTextSchema,
  }),
  z.strictObject({
    kind: z.literal("image_context"),
    blockId: UnicodeTextSchema.min(1).max(512),
    occurrenceId: z.uuid(),
    text: UnicodeTextSchema.min(1),
  }),
  z.strictObject({
    kind: z.literal("table"),
    blockId: UnicodeTextSchema.min(1).max(512),
    columns: z.array(UnicodeTextSchema).min(1),
    rows: z.array(z.array(UnicodeTextSchema)).default([]),
  }).superRefine((table, context) => {
    table.rows.forEach((row, index) => {
      if (row.length !== table.columns.length) {
        context.addIssue({ code: "custom", path: ["rows", index], message: "表格每行单元格数必须与列数一致" });
      }
    });
  }),
  z.strictObject({
    kind: z.literal("fact"),
    blockId: UnicodeTextSchema.min(1).max(512),
    refId: UnicodeTextSchema.min(1).max(512),
    text: IndexTextSchema.min(1),
    locatorKey: UnicodeTextSchema.min(1).max(512).nullable().default(null),
  }),
]);
export type ChunkBlockInput = z.infer<typeof ChunkBlockInputSchema>;

export const ChunkSectionInputSchema = z.strictObject({
  sectionId: UnicodeTextSchema.min(1).max(512),
  title: ChunkCandidateFieldsSchema.shape.title.min(1),
  page: z.int().positive().nullable().default(null),
  sourceVersionId: z.uuid(),
  tags: ChunkCandidateFieldsSchema.shape.tags.default([]),
  metadata: ChunkSectionMetadataSchema,
  blocks: z.array(ChunkBlockInputSchema),
});
export type ChunkSectionInput = z.infer<typeof ChunkSectionInputSchema>;

export const ChunkSectionsInputSchema = z.array(ChunkSectionInputSchema).min(1);
export type ChunkSectionsInput = z.infer<typeof ChunkSectionsInputSchema>;

export const ChunkDraftSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  sectionId: UnicodeTextSchema.min(1).max(512).nullable().default(null),
  candidate: ChunkCandidateSchema,
  chunkKind: z.enum(["text", "table", "image_context", "fact"]),
  contentHash: Sha256Schema,
  blockIds: z.array(z.string().min(1)),
  overlapChars: z.int().nonnegative().max(100),
});
export type ChunkDraft = z.infer<typeof ChunkDraftSchema>;

export const ChunkSearchRowSchema = ChunkCandidateFieldsSchema.omit({
  schemaVersion: true, refId: true, text: true,
}).extend({
  chunkId: ChunkCandidateFieldsSchema.shape.refId,
  body: ChunkCandidateFieldsSchema.shape.text,
}).refine(hasOrderedEffectiveDates, effectiveDatesMessage);
export type ChunkSearchRow = z.infer<typeof ChunkSearchRowSchema>;
