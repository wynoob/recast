import { z } from "zod";
import {
  HashSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";
import {
  LocatorSchema,
  SafeRelativePathSchema,
  type Locator,
} from "./locators.js";

export const DocumentFormatSchema = z.enum(["markdown", "html", "html_zip", "pdf", "pptx"]);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

export const DocumentExtractionStatusSchema = z.enum(["complete", "partial", "blocked"]);
export type DocumentExtractionStatus = z.infer<typeof DocumentExtractionStatusSchema>;

export const DocumentCapabilitiesSchema = z.strictObject({
  pageImages: z.enum(["extracted", "unavailable", "disabled", "not_applicable"]),
  libreOffice: z.enum(["available", "unavailable", "not_applicable"]),
  ocr: z.literal("blocked"),
  renderer: z.string().nullable(),
});
export type DocumentCapabilities = z.infer<typeof DocumentCapabilitiesSchema>;

export const DocumentWarningSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  sectionAdapterId: z.string().min(1).nullable(),
  locator: LocatorSchema.nullable(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type DocumentWarning = z.infer<typeof DocumentWarningSchema>;

export const DocumentBlockDraftSchema = z.strictObject({
  adapterId: z.string().min(1).max(512),
  ordinal: z.int().positive(),
  text: z.string().min(1),
  locator: LocatorSchema,
});
export type DocumentBlockDraft = z.infer<typeof DocumentBlockDraftSchema>;

export const DocumentSectionDraftSchema = z.strictObject({
  adapterId: z.string().min(1).max(512),
  ordinal: z.int().positive(),
  title: z.string().min(1).max(500),
  headingPath: z.string().min(1).max(4096),
  text: z.string(),
  locator: LocatorSchema,
  blocks: z.array(DocumentBlockDraftSchema),
  notes: z.string(),
});
export type DocumentSectionDraft = z.infer<typeof DocumentSectionDraftSchema>;

export const DocumentChunkDraftSchema = z.strictObject({
  sectionAdapterId: z.string().min(1).max(512),
  chunkId: UuidSchema,
  chunkKind: z.enum(["text", "table", "image_context", "fact"]),
  text: z.string().min(1),
  title: z.string().max(500),
  tags: z.array(z.string().max(200)).max(200),
  merchantId: UuidSchema.nullable(),
  mediaKind: z.enum(["document", "image", "gif", "video", "audio"]),
  recordDate: z.iso.date().nullable(),
  effectiveFrom: z.iso.date().nullable(),
  effectiveTo: z.iso.date().nullable(),
  audience: z.array(z.string().max(100)).max(100),
  functions: z.array(z.string().max(100)).max(100),
  obsolete: z.boolean(),
  availability: z.enum(["available", "missing", "unsupported"]),
  locationKey: z.string().min(1).max(512),
  contentHash: HashSchema,
  blockAdapterIds: z.array(z.string().min(1).max(512)),
  overlapChars: z.int().nonnegative().max(100),
});
export type DocumentChunkDraft = z.infer<typeof DocumentChunkDraftSchema>;

export const DocumentOccurrenceDraftSchema = z.strictObject({
  adapterId: z.string().min(1).max(512),
  mediaAdapterId: z.string().min(1).max(512).nullable(),
  sectionAdapterId: z.string().min(1).max(512),
  locator: LocatorSchema,
  headingPath: z.string().max(4096),
  beforeText: z.string().max(1_000),
  afterText: z.string().max(1_000),
  mediaStatus: z.enum(["available", "missing", "unsupported"]),
  errorCode: z.string().min(1).max(128).nullable(),
});
export type DocumentOccurrenceDraft = z.infer<typeof DocumentOccurrenceDraftSchema>;

export const DocumentExtractionDraftSchema = z.strictObject({
  format: DocumentFormatSchema,
  processorVersion: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  pageCount: z.int().nonnegative().nullable(),
  status: DocumentExtractionStatusSchema,
  capabilities: DocumentCapabilitiesSchema,
  warnings: z.array(DocumentWarningSchema),
  sections: z.array(DocumentSectionDraftSchema).max(2_000),
  occurrences: z.array(DocumentOccurrenceDraftSchema).max(20_000),
  chunkDrafts: z.array(DocumentChunkDraftSchema).max(50_000),
  mediaCount: z.int().nonnegative().max(5_000),
  mediaBatchCount: z.int().nonnegative().max(1_000),
  extractionSnapshot: z.record(z.string(), z.unknown()),
});
export type DocumentExtractionDraft = z.infer<typeof DocumentExtractionDraftSchema>;

export const StagedDocumentMediaSchema = z.strictObject({
  adapterId: z.string().min(1).max(512),
  mediaKind: z.enum(["image", "gif", "video", "audio", "other"]),
  mediaStatus: z.literal("extracted"),
  sourceInternalPath: z.string().min(1).max(4096),
  relativePath: SafeRelativePathSchema,
  sha256: HashSchema,
  bytes: z.int().nonnegative(),
  mime: z.string().min(1),
  role: z.enum(["document_media", "page_image"]),
});
export type StagedDocumentMedia = z.infer<typeof StagedDocumentMediaSchema>;

export const DocumentMediaBatchSchema = z.strictObject({
  scanItemId: UuidSchema,
  batchIndex: z.int().nonnegative(),
  batchCount: z.int().positive().max(1_000),
  media: z.array(StagedDocumentMediaSchema).min(1).max(32),
}).refine((value) => value.batchIndex < value.batchCount, "媒体批次序号必须小于批次总数");
export type DocumentMediaBatch = z.infer<typeof DocumentMediaBatchSchema>;

export const DocumentBlockViewSchema = z.strictObject({
  id: UuidSchema,
  ordinal: z.int().positive(),
  text: z.string(),
  locator: LocatorSchema,
});
export type DocumentBlockView = z.infer<typeof DocumentBlockViewSchema>;

export const DocumentSectionViewSchema = z.strictObject({
  id: UuidSchema,
  ordinal: z.int().positive(),
  title: z.string(),
  headingPath: z.string(),
  text: z.string(),
  locator: LocatorSchema,
  blocks: z.array(DocumentBlockViewSchema),
  notes: z.string(),
});
export type DocumentSectionView = z.infer<typeof DocumentSectionViewSchema>;

export const DocumentSnapshotViewSchema = z.strictObject({
  format: DocumentFormatSchema,
  processorVersion: z.string(),
  status: DocumentExtractionStatusSchema,
  capabilities: DocumentCapabilitiesSchema,
  warnings: z.array(DocumentWarningSchema),
  pageCount: z.int().nonnegative().nullable(),
  title: z.string(),
});
export type DocumentSnapshotView = z.infer<typeof DocumentSnapshotViewSchema>;

export const SourceDocumentViewSchema = z.strictObject({
  snapshot: DocumentSnapshotViewSchema,
  sections: z.array(DocumentSectionViewSchema),
  sourceVersionId: UuidSchema,
  sourceId: UuidSchema,
  sourceTitle: z.string(),
  originalFileUrl: z.string(),
});
export type SourceDocumentView = z.infer<typeof SourceDocumentViewSchema>;

export const DocumentMetadataSchema = z.strictObject({
  format: DocumentFormatSchema,
  processorVersion: z.string(),
  status: DocumentExtractionStatusSchema,
  capabilities: DocumentCapabilitiesSchema,
  warnings: z.array(DocumentWarningSchema),
  pageCount: z.int().nonnegative().nullable(),
});
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;

export const DocumentSourcePreviewSchema = z.strictObject({
  sourceId: UuidSchema,
  sourceVersionId: UuidSchema,
  title: z.string(),
  format: DocumentFormatSchema,
  status: DocumentExtractionStatusSchema,
  pageCount: z.int().nonnegative().nullable(),
  sectionCount: z.int().nonnegative(),
  blockCount: z.int().nonnegative(),
  warningCount: z.int().nonnegative(),
  updatedAt: UtcTimeSchema,
});
export type DocumentSourcePreview = z.infer<typeof DocumentSourcePreviewSchema>;

export const DocumentChunkViewSchema = z.strictObject({
  id: UuidSchema,
  sectionId: UuidSchema.nullable(),
  text: z.string(),
  kind: z.string(),
  blockIds: z.array(UuidSchema),
  locators: z.array(LocatorSchema),
});
export type DocumentChunkView = z.infer<typeof DocumentChunkViewSchema>;

export const DocumentBlockIdsSchema = z.array(UuidSchema);
export type DocumentBlockIds = z.infer<typeof DocumentBlockIdsSchema>;

export const DocumentLocatorsSchema = z.array(LocatorSchema);
export type DocumentLocators = z.infer<typeof DocumentLocatorsSchema>;

export const DocumentImportItemSchema = z.strictObject({
  kind: z.literal("document"),
  document: DocumentExtractionDraftSchema,
  markdownOccurrences: z.array(z.unknown()).max(0).default([]),
});

export function locatorKey(locator: Locator): string {
  switch (locator.kind) {
    case "block":
      return `block:${locator.blockId}`;
    case "page":
      return `page:${locator.page}`;
    case "dom":
      return `dom:${locator.domPath}`;
    case "time":
      return `time:${locator.startMs}-${locator.endMs}`;
    case "local_file":
      return `local_file:${locator.relativePath}`;
    case "markdown":
      return `markdown:${locator.line}:${locator.column}:${locator.ordinal}:${locator.rawTarget}`;
    case "markdown_text":
      return `markdown_text:${locator.line}:${locator.column}`;
  }
}
