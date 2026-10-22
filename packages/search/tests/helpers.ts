import {
  ChunkCandidateSchema,
  ChunkSearchRowSchema,
  createEmbeddingNamespace,
  type ChunkCandidate,
  type ChunkSearchRow,
  type EmbeddingNamespace,
} from "../src/index.js";

export const SOURCE_VERSION_ID = "11111111-1111-4111-8111-111111111111";
export const MERCHANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MERCHANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const OCCURRENCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export function makeCandidate(overrides: Partial<ChunkCandidate> = {}): ChunkCandidate {
  return ChunkCandidateSchema.parse({
    schemaVersion: 1,
    refId: "chunk-1",
    refType: "chunk",
    occurrenceId: null,
    sourceVersionId: SOURCE_VERSION_ID,
    title: "销售分析",
    text: "门店销售分析正文",
    tags: ["经营"],
    merchantId: MERCHANT_A,
    mediaKind: "document",
    recordDate: "2026-05-10",
    effectiveFrom: null,
    effectiveTo: null,
    audience: ["管理层"],
    functions: ["搜索"],
    obsolete: false,
    availability: "available",
    locationKey: "section:s-1:text:0",
    ...overrides,
  });
}

export function makeSearchRow(overrides: Partial<ChunkSearchRow> = {}): ChunkSearchRow {
  return ChunkSearchRowSchema.parse({
    chunkId: "chunk-1",
    refType: "chunk",
    sourceVersionId: SOURCE_VERSION_ID,
    occurrenceId: null,
    locationKey: "section:s-1:text:0",
    availability: "available",
    mediaKind: "document",
    merchantId: MERCHANT_A,
    recordDate: "2026-05-10",
    effectiveFrom: null,
    effectiveTo: null,
    obsolete: false,
    audience: ["管理层"],
    functions: ["搜索"],
    title: "销售日报",
    tags: ["经营"],
    body: "门店销售分析正文",
    ...overrides,
  });
}

export function makeNamespace(
  overrides: Partial<{
    provider: string;
    model: string;
    preprocessingVersion: string;
    dimension: number;
  }> = {},
): EmbeddingNamespace {
  return createEmbeddingNamespace({
    schemaVersion: 1,
    provider: overrides.provider ?? "dmall-test",
    model: overrides.model ?? "embedding-v1",
    preprocessingVersion: overrides.preprocessingVersion ?? "nfkc-lower-v1",
    dimension: overrides.dimension ?? 3,
  });
}
