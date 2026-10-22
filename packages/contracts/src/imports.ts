import { z } from "zod";
import {
  HashSchema,
  SchemaVersionSchema,
  UtcTimeSchema,
  UuidSchema,
  WorkerFenceSchema,
} from "./ids.js";
import {
  AssetMapCommitResultSchema,
  AssetMapSelectionSchema,
} from "./asset-map.js";
import {
  LocalFileLocatorSchema,
  MarkdownLocatorSchema,
  OccurrenceLocatorSchema,
  SafeRelativePathSchema,
  type MarkdownLocator,
  type OccurrenceLocator,
  type SafeRelativePath,
} from "./locators.js";
import {
  DocumentExtractionDraftSchema,
  DocumentMediaBatchSchema,
  SourceDocumentViewSchema,
} from "./documents.js";

export {
  LocalFileLocatorSchema,
  MarkdownLocatorSchema,
  OccurrenceLocatorSchema,
  SafeRelativePathSchema,
};
export type { MarkdownLocator, OccurrenceLocator, SafeRelativePath };

export const ScanStatusSchema = z.enum([
  "queued",
  "scanning",
  "ready",
  "consumed",
  "expired",
  "failed",
  "cancelled",
]);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const ScanItemStatusSchema = z.enum([
  "candidate",
  "excluded",
  "unsupported",
  "unreadable",
]);
export type ScanItemStatus = z.infer<typeof ScanItemStatusSchema>;

export const ImportMediaKindSchema = z.enum([
  "image",
  "gif",
  "video",
  "markdown",
  "pdf",
  "pptx",
  "html",
  "html_zip",
  "unsupported",
]);
export type ImportMediaKind = z.infer<typeof ImportMediaKindSchema>;

export const ScanCountsSchema = z.strictObject({
  candidate: z.int().nonnegative(),
  excluded: z.int().nonnegative(),
  unsupported: z.int().nonnegative(),
  unreadable: z.int().nonnegative(),
  mp4: z.int().nonnegative(),
  gif: z.int().nonnegative(),
  image: z.int().nonnegative(),
  markdown: z.int().nonnegative(),
  pdf: z.int().nonnegative(),
  pptx: z.int().nonnegative(),
  html: z.int().nonnegative(),
  htmlZip: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
});
export type ScanCounts = z.infer<typeof ScanCountsSchema>;

export const ScanItemViewSchema = z.strictObject({
  id: UuidSchema,
  relativePath: SafeRelativePathSchema,
  basename: z.string(),
  kind: ImportMediaKindSchema,
  mime: z.string().nullable(),
  bytes: z.int().nonnegative(),
  status: ScanItemStatusSchema,
  reasonCode: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ScanItemView = z.infer<typeof ScanItemViewSchema>;

export const ScanExclusionSchema = z.strictObject({
  code: z.string(),
  count: z.int().positive(),
  examples: z.array(SafeRelativePathSchema).max(5),
});
export type ScanExclusion = z.infer<typeof ScanExclusionSchema>;

export const ScanDetailSchema = z.strictObject({
  scanId: UuidSchema,
  jobId: UuidSchema,
  status: ScanStatusSchema,
  sourceKind: z.enum(["local_directory", "upload"]),
  displayName: z.string(),
  counts: ScanCountsSchema,
  exclusions: z.array(ScanExclusionSchema),
  warnings: z.array(z.string()),
  expiresAt: UtcTimeSchema,
});
export type ScanDetail = z.infer<typeof ScanDetailSchema>;

export const ScanCreateRequestSchema = z.discriminatedUnion("sourceKind", [
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    sourceKind: z.literal("local_directory"),
    rootPath: z.string().min(1).max(4096),
    options: z.strictObject({ generatePreviews: z.literal(true) }),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    sourceKind: z.literal("upload"),
    fileIds: z.array(UuidSchema).min(1).max(100),
    options: z.strictObject({ generatePreviews: z.literal(true) }),
  }),
]);
export type ScanCreateRequest = z.infer<typeof ScanCreateRequestSchema>;

export const ImportSelectionSchema = z.strictObject({
  mode: z.enum(["all", "explicit"]).default("all"),
  includeItemIds: z.array(UuidSchema),
  excludeItemIds: z.array(UuidSchema),
});
export type ImportSelection = z.infer<typeof ImportSelectionSchema>;

export const ImportOptionsSchema = z.strictObject({
  generatePreviews: z.literal(true),
  ocr: z.literal("blocked"),
  allowExternalModel: z.literal(false),
  allowFeishu: z.literal(false),
});

export const ImportCreateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  scanId: UuidSchema,
  selection: ImportSelectionSchema,
  options: ImportOptionsSchema,
  assetMap: AssetMapSelectionSchema.optional(),
});
export type ImportCreateRequest = z.infer<typeof ImportCreateRequestSchema>;

export const ImportRetryRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  itemIds: z.array(UuidSchema).min(1),
});

export const ImportItemStateSchema = z.enum([
  "pending",
  "copying",
  "probing",
  "previewing",
  "committed",
  "failed",
  "skipped",
]);
export type ImportItemState = z.infer<typeof ImportItemStateSchema>;

export const ImportItemStoredResultSchema = z
  .strictObject({
    kind: z.enum(["image", "gif", "video", "markdown", "document"]),
    sha256: HashSchema,
    bytes: z.int().nonnegative(),
    mime: z.string().min(1),
    mapping: AssetMapCommitResultSchema,
    documentStatus: z.enum(["complete", "partial", "blocked"]),
    documentFormat: z.enum(["markdown", "html", "html_zip", "pdf", "pptx"]),
  })
  .partial();
export type ImportItemStoredResult = z.infer<typeof ImportItemStoredResultSchema>;

export const ImportItemViewSchema = z.strictObject({
  id: UuidSchema,
  scanItemId: UuidSchema,
  relativePath: SafeRelativePathSchema,
  state: ImportItemStateSchema,
  attempt: z.int().nonnegative(),
  assetId: UuidSchema.nullable(),
  sourceVersionId: UuidSchema.nullable(),
  occurrenceId: UuidSchema.nullable(),
  documentStatus: z.enum(["complete", "partial", "blocked"]).nullable().default(null),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type ImportItemView = z.infer<typeof ImportItemViewSchema>;

export const ImportResultSchema = z.strictObject({
  jobType: z.literal("local_import"),
  importId: UuidSchema,
  committed: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  assetIds: z.array(UuidSchema),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const AssetMapSourceStatusSchema = z.strictObject({
  sourceScanItemId: UuidSchema,
  relativePath: SafeRelativePathSchema,
  mapIndex: z.int().min(0).max(2),
  status: z.enum(["pending", "applied", "failed", "skipped"]),
  sourceVersionId: UuidSchema.nullable(),
  entryCount: z.int().nonnegative(),
  linkedEntryCount: z.int().nonnegative(),
  warningCount: z.int().nonnegative(),
  errorCode: z.string().nullable(),
});
export type AssetMapSourceStatus = z.infer<typeof AssetMapSourceStatusSchema>;

export const AssetMapSummarySchema = z.strictObject({
  requestedSourceCount: z.int().min(1).max(3),
  appliedSourceCount: z.int().nonnegative(),
  status: z.enum(["pending", "applied", "partial", "failed", "skipped"]),
  entryCount: z.int().nonnegative(),
  linkedEntryCount: z.int().nonnegative(),
  warningCount: z.int().nonnegative(),
  sources: z.array(AssetMapSourceStatusSchema).min(1).max(3),
});
export type AssetMapSummary = z.infer<typeof AssetMapSummarySchema>;

export const ImportDetailSchema = z.strictObject({
  importId: UuidSchema,
  jobId: UuidSchema,
  scanId: UuidSchema,
  status: z.enum(["queued", "running", "waiting_input", "succeeded", "partial", "failed", "cancelled"]),
  phase: z.string(),
  counts: z.strictObject({
    pending: z.int().nonnegative(),
    committed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
    total: z.int().nonnegative(),
  }),
  items: z.array(ImportItemViewSchema),
  nextCursor: z.string().nullable(),
  result: ImportResultSchema.nullable(),
  mapping: AssetMapSummarySchema.nullable(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type ImportDetail = z.infer<typeof ImportDetailSchema>;

export const UploadChunkResultSchema = z.strictObject({
  fileId: UuidSchema,
  receivedBytes: z.int().nonnegative(),
  nextChunk: z.int().nonnegative(),
  complete: z.boolean(),
  sha256: HashSchema.nullable(),
  bytes: z.int().nonnegative().nullable(),
  mime: z.string().nullable(),
  magicKind: ImportMediaKindSchema.nullable(),
});
export type UploadChunkResult = z.infer<typeof UploadChunkResultSchema>;

export const PathIdentitySchema = z.strictObject({
  path: z.string().min(1), deviceId: z.string().min(1), inode: z.string().min(1),
});

export const ScanItemResultSchema = z.strictObject({
  scanItemId: UuidSchema,
  relativePath: SafeRelativePathSchema,
  basename: z.string().min(1),
  kind: ImportMediaKindSchema,
  mime: z.string().nullable(),
  bytes: z.int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
  deviceId: z.string().min(1),
  inode: z.string().min(1),
  magicPrefixHex: z.string().regex(/^[0-9a-f]*$/).max(131072),
  status: ScanItemStatusSchema,
  exclusionCode: z.string().nullable(),
  metadata: z.strictObject({
    extensionMismatch: z.boolean(),
    extension: z.string(),
    pathIdentity: z.array(PathIdentitySchema).optional(),
  }),
});
export type ScanItemResult = z.infer<typeof ScanItemResultSchema>;

export const ImageProbeSchema = z.strictObject({
  kind: z.literal("image"),
  width: z.int().positive(),
  height: z.int().positive(),
  format: z.string().min(1),
  hasAlpha: z.boolean(),
});
export const GifProbeSchema = z.strictObject({
  kind: z.literal("gif"),
  width: z.int().positive(),
  height: z.int().positive(),
  pages: z.int().positive(),
  durationMs: z.int().nonnegative().nullable(),
});
export const VideoProbeSchema = z.strictObject({
  kind: z.literal("video"),
  durationMs: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  videoCodec: z.string().min(1),
  fps: z.number().finite().positive(),
  audioCodec: z.string().nullable(),
  frameCount: z.int().positive().nullable(),
});
export const MediaProbeSchema = z.discriminatedUnion("kind", [
  ImageProbeSchema,
  GifProbeSchema,
  VideoProbeSchema,
]);
export type MediaProbe = z.infer<typeof MediaProbeSchema>;

export const MarkdownOccurrenceDraftSchema = z.strictObject({
  locator: MarkdownLocatorSchema,
  headingPath: z.string(),
  beforeText: z.string().max(1_000),
  afterText: z.string().max(1_000),
  mediaStatus: z.enum(["available", "missing", "unsupported"]),
  resolvedRelativePath: SafeRelativePathSchema.nullable(),
  errorCode: z.enum(["MISSING_DEPENDENCY", "SYMLINK_OUTSIDE_ROOT", "UNSUPPORTED_FORMAT"]).nullable(),
});
export type MarkdownOccurrenceDraft = z.infer<typeof MarkdownOccurrenceDraftSchema>;

export const StagedFileSchema = z.strictObject({
  role: z.enum(["original", "poster", "video_preview"]),
  relativePath: SafeRelativePathSchema,
  sha256: HashSchema,
  bytes: z.int().nonnegative(),
  mime: z.string().min(1),
});
export type StagedFile = z.infer<typeof StagedFileSchema>;

export const ImportItemCommittedSchema = z.strictObject({
  state: z.literal("committed"),
  scanItemId: UuidSchema,
  relativePath: SafeRelativePathSchema,
  kind: z.enum(["image", "gif", "video", "markdown", "document"]),
  title: z.string().min(1).max(200),
  sha256: HashSchema,
  bytes: z.int().nonnegative(),
  mime: z.string().min(1),
  processorVersions: z.record(z.string(), z.string()),
  probe: MediaProbeSchema.nullable(),
  markdownOccurrences: z.array(MarkdownOccurrenceDraftSchema).max(10_000).default([]),
  document: DocumentExtractionDraftSchema.optional(),
});
export type ImportItemCommitted = z.infer<typeof ImportItemCommittedSchema>;

export const ImportItemFailedSchema = z.strictObject({
  state: z.literal("failed"),
  scanItemId: UuidSchema,
  relativePath: SafeRelativePathSchema,
  errorCode: z.enum([
    "SOURCE_CHANGED_RESCAN_REQUIRED",
    "SOURCE_UNREADABLE",
    "MISSING_DEPENDENCY",
    "UNSUPPORTED_FORMAT",
    "PATH_NOT_ALLOWED",
    "SYMLINK_OUTSIDE_ROOT",
    "DISK_FULL",
    "INTERNAL_ERROR",
  ]),
  message: z.string(),
  retryable: z.boolean(),
});
export type ImportItemFailed = z.infer<typeof ImportItemFailedSchema>;

export const ImportItemResultSchema = z.discriminatedUnion("state", [
  ImportItemCommittedSchema,
  ImportItemFailedSchema,
]);
export type ImportItemResult = z.infer<typeof ImportItemResultSchema>;

export const ItemResultMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    type: z.literal("item_result"),
    messageId: UuidSchema,
    fence: WorkerFenceSchema,
    kind: z.literal("scan_item"),
    item: ScanItemResultSchema,
    stagedFiles: z.array(StagedFileSchema).max(0),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    type: z.literal("item_result"),
    messageId: UuidSchema,
    fence: WorkerFenceSchema,
    kind: z.literal("import_item"),
    item: ImportItemResultSchema,
    stagedFiles: z.array(StagedFileSchema).max(3),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    type: z.literal("item_result"),
    messageId: UuidSchema,
    fence: WorkerFenceSchema,
    kind: z.literal("document_media_batch"),
    batch: DocumentMediaBatchSchema,
    stagedFiles: z.array(StagedFileSchema).max(0),
  }),
]);
export type ItemResultMessage = z.infer<typeof ItemResultMessageSchema>;

export const ScanCheckpointSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("local_scan"),
  scannerVersion: z.literal("dcw-directory-scan/1"),
  rootIdentity: HashSchema,
  stack: z.array(z.union([z.literal(""), SafeRelativePathSchema])),
  nextOrdinal: z.int().nonnegative(),
  visitedDirectoryCount: z.int().nonnegative(),
  candidateCount: z.int().nonnegative(),
  excludedCount: z.int().nonnegative(),
  unsupportedCount: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  itemDigest: HashSchema,
});
export type ScanCheckpoint = z.infer<typeof ScanCheckpointSchema>;

export const ImportCheckpointSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("local_import"),
  pipelineVersion: z.literal("dcw-local-import/1"),
  scanId: UuidSchema,
  manifestHash: HashSchema,
  lastCommittedItemId: UuidSchema.nullable(),
});
export type ImportCheckpoint = z.infer<typeof ImportCheckpointSchema>;

export const AssetAvailabilitySchema = z.enum(["available", "missing", "unsupported"]);
export type AssetAvailability = z.infer<typeof AssetAvailabilitySchema>;

export const AssetFieldOriginSchema = z.enum(["source", "manual"]);
export type AssetFieldOrigin = z.infer<typeof AssetFieldOriginSchema>;

export const AssetFieldOriginsSchema = z.strictObject({
  title: AssetFieldOriginSchema,
  tags: AssetFieldOriginSchema,
});
export type AssetFieldOrigins = z.infer<typeof AssetFieldOriginsSchema>;

export const SourceSummarySchema = z.strictObject({
  id: UuidSchema,
  kind: z.string().min(1).max(64),
  title: z.string(),
  status: z.enum(["active", "archived"]),
  currentVersionId: UuidSchema.nullable(),
  occurrenceCount: z.int().nonnegative(),
  missingOccurrenceCount: z.int().nonnegative(),
  linkedAssetCount: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export const SourceListSchema = z.strictObject({
  items: z.array(SourceSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
});
export type SourceList = z.infer<typeof SourceListSchema>;

export const ListSourcesQuerySchema = z.strictObject({
  kind: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const AssetSummaryV2Schema = z.strictObject({
  id: UuidSchema,
  mediaKind: z.enum(["image", "gif", "video"]),
  title: z.string(),
  tags: z.array(z.string()),
  origins: AssetFieldOriginsSchema,
  version: z.int().nonnegative(),
  mime: z.string(),
  bytes: z.int().nonnegative(),
  availability: AssetAvailabilitySchema,
  previewFileUrl: z.string().nullable(),
  posterFileUrl: z.string().nullable(),
  originalFileUrl: z.string().nullable(),
  durationMs: z.int().nullable(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  merchant: z.string().nullable(),
  sourceCount: z.int().nonnegative(),
  occurrenceCount: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
});
export type AssetSummaryV2 = z.infer<typeof AssetSummaryV2Schema>;

export const AssetMetadataSchema = z.strictObject({
  magicMime: z.string(),
  extensionMismatch: z.boolean(),
  processorVersions: z.record(z.string(), z.string()),
  probe: MediaProbeSchema.nullable(),
});
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;

export const AssetHumanFieldsSchema = z.strictObject({
  title: z.string(),
  tags: z.array(z.string()),
  origins: AssetFieldOriginsSchema,
});
export type AssetHumanFields = z.infer<typeof AssetHumanFieldsSchema>;

export const AssetOccurrenceViewSchema = z.strictObject({
  id: UuidSchema,
  sourceId: UuidSchema,
  sourceVersionId: UuidSchema,
  sourceTitle: z.string(),
  sourceRelativePath: z.string(),
  locator: OccurrenceLocatorSchema,
  headingPath: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
  mediaStatus: z.enum(["discovered", "available", "missing", "unsupported"]),
  errorCode: z.string().nullable(),
});
export type AssetOccurrenceView = z.infer<typeof AssetOccurrenceViewSchema>;

export const AssetMapSuggestionProvenanceSchema = z.strictObject({
  sourceId: UuidSchema,
  sourceVersionId: UuidSchema,
  sourceTitle: z.string(),
  sourceRelativePath: z.string(),
  sectionHeading: z.string(),
  tableIndex: z.int().nonnegative(),
  rowIndex: z.int().nonnegative(),
  lineStart: z.int().positive(),
  lineEnd: z.int().positive(),
  fileCell: z.string().min(1),
  mapIndex: z.int().min(0).max(2),
});
export type AssetMapSuggestionProvenance = z.infer<
  typeof AssetMapSuggestionProvenanceSchema
>;

const textEncoder = new TextEncoder();

export const AssetSourceSuggestionSchema = z
  .strictObject({
    origin: z.literal("source"),
    parserVersion: z.literal("dcw-asset-map/1"),
    title: z.string().max(200).nullable(),
    usageMarkdown: z.string().min(1),
    usageText: z.string().min(1),
    ignoredSuggestionCount: z.int().nonnegative(),
    provenance: AssetMapSuggestionProvenanceSchema,
  })
  .superRefine((value, ctx) => {
    if (textEncoder.encode(value.usageMarkdown).byteLength > 16384) {
      ctx.addIssue({ code: "custom", message: "usageMarkdown 超过 16KiB" });
    }
    if (textEncoder.encode(value.usageText).byteLength > 16384) {
      ctx.addIssue({ code: "custom", message: "usageText 超过 16KiB" });
    }
  });
export type AssetSourceSuggestion = z.infer<typeof AssetSourceSuggestionSchema>;

export const AssetDetailV2Schema = z.strictObject({
  summary: AssetSummaryV2Schema,
  metadata: AssetMetadataSchema,
  humanFields: AssetHumanFieldsSchema,
  occurrences: z.array(AssetOccurrenceViewSchema),
  sourceSuggestion: AssetSourceSuggestionSchema.nullable(),
});
export type AssetDetailV2 = z.infer<typeof AssetDetailV2Schema>;

export const PatchAssetRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedVersion: z.int().nonnegative(),
  title: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string()).max(20).optional(),
});
export type PatchAssetRequest = z.infer<typeof PatchAssetRequestSchema>;

export const AssetPatchResultSchema = z.strictObject({
  id: UuidSchema,
  version: z.int().nonnegative(),
  title: z.string(),
  tags: z.array(z.string()),
  origins: AssetFieldOriginsSchema,
});
export type AssetPatchResult = z.infer<typeof AssetPatchResultSchema>;

export const SourceContextSchema = z.strictObject({
  source: z.strictObject({
    id: UuidSchema,
    kind: z.string(),
    title: z.string(),
    canonicalKey: z.string(),
    originalUri: z.string().nullable(),
    status: z.enum(["active", "archived"]),
  }),
  version: z.strictObject({
    id: UuidSchema,
    sourceId: UuidSchema,
    fingerprint: HashSchema,
    snapshotBlobHash: HashSchema,
    capturedAt: UtcTimeSchema,
    fileUrl: z.string(),
  }),
  document: SourceDocumentViewSchema.nullable(),
  occurrences: z.array(AssetOccurrenceViewSchema),
});
export type SourceContext = z.infer<typeof SourceContextSchema>;

export const ImportManifestItemSchema = z.strictObject({
  scanItemId: UuidSchema,
  relativePath: SafeRelativePathSchema,
  rootPath: z.string().min(1),
  sourcePath: z.string().min(1),
  pathIdentity: z.array(PathIdentitySchema).optional(),
  state: ImportItemStateSchema.optional(),
  bytes: z.int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
  deviceId: z.string().min(1),
  inode: z.string().min(1),
  kind: ImportMediaKindSchema,
  mime: z.string().nullable(),
  sha256: HashSchema.nullable(),
  plannedSourceVersionId: UuidSchema,
  committed: z.boolean().optional(),
}).transform(({committed, state, ...item}) => ({...item, state: state ?? (committed === true ? "committed" : "pending")}));
export type ImportManifestItem = z.infer<typeof ImportManifestItemSchema>;

export const ImportManifestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("local_import"),
  scanId: UuidSchema,
  manifestHash: HashSchema,
  items: z.array(ImportManifestItemSchema),
});
export type ImportManifest = z.infer<typeof ImportManifestSchema>;

export const UploadScanManifestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("local_scan"),
  sourceKind: z.literal("upload"),
  uploadSetId: HashSchema,
  files: z.array(
    z.strictObject({
      fileId: UuidSchema,
      relativePath: SafeRelativePathSchema,
      sourcePath: z.string().min(1),
      sha256: HashSchema,
      bytes: z.int().nonnegative(),
      mime: z.string().min(1),
    }),
  ),
});
export type UploadScanManifest = z.infer<typeof UploadScanManifestSchema>;
