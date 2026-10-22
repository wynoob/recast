import { z } from "zod";
import {
  AstSchema,
  ContentKindSchema,
  RevisionCreatedBySchema,
} from "./ast.js";
import {
  HashSchema,
  NodeIdSchema,
  SchemaVersionSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";
import { BriefSchema } from "./api.js";
import {
  CapabilitiesSchema,
  LayoutDefinitionSchema,
  NarrativeDefinitionSchema,
  TemplateSlotSchema,
  TemplatePackageSchema,
  ThemeSchema,
} from "./templates.js";

export const ExportFormatSchema = z.enum([
  "html_zip",
  "pdf",
  "project_bundle",
  "feishu_doc",
]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const ExportStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "succeeded",
  "partial",
  "failed",
  "blocked",
  "cancelled",
]);
export type ExportStatus = z.infer<typeof ExportStatusSchema>;

export const ExportArtifactKindSchema = z.enum([
  "html_zip",
  "pdf",
  "project_bundle",
  "feishu_receipt",
  "preview",
]);
export type ExportArtifactKind = z.infer<typeof ExportArtifactKindSchema>;

export const ExportOptionsSchema = z.strictObject({
  speakerNotes: z.boolean().default(false),
  includeHiddenBlocks: z.literal(false).default(false),
  title: z.string().trim().min(1).max(200).optional(),
  revisionIds: z.array(UuidSchema).max(200).optional(),
  feishu: z
    .strictObject({
      publish: z.literal(true),
      confirmedCreateDocument: z.literal(true),
      folderToken: z.string().trim().max(512).optional(),
    })
    .optional(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export const CreateExportRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  renditionId: UuidSchema,
  revisionId: UuidSchema,
  format: ExportFormatSchema,
  options: ExportOptionsSchema.default({
    speakerNotes: false,
    includeHiddenBlocks: false,
  }),
});
export type CreateExportRequest = z.infer<typeof CreateExportRequestSchema>;

export const OutputMediaKindSchema = z.enum(["image", "gif", "video", "other"]);
export type OutputMediaKind = z.infer<typeof OutputMediaKindSchema>;

export const OutputMediaPlanItemSchema = z.strictObject({
  key: z.string().min(1),
  role: z.enum(["image", "video", "poster", "source_preview", "container"]),
  mediaKind: OutputMediaKindSchema,
  assetVersionId: UuidSchema.nullable(),
  assetId: UuidSchema.nullable(),
  derivativeId: UuidSchema.nullable(),
  occurrenceId: UuidSchema.nullable(),
  segmentId: UuidSchema.nullable(),
  blobHash: HashSchema,
  relativePath: z.string().min(1),
  mime: z.string().min(1),
  bytes: z.int().nonnegative(),
  originalName: z.string().min(1),
  startMs: z.int().nonnegative().nullable().default(null),
  endMs: z.int().nonnegative().nullable().default(null),
});
export type OutputMediaPlanItem = z.infer<typeof OutputMediaPlanItemSchema>;

export const ExportMediaSummarySchema = z.strictObject({
  total: z.int().nonnegative(),
  images: z.int().nonnegative(),
  gifs: z.int().nonnegative(),
  videos: z.int().nonnegative(),
  missing: z.array(
    z.strictObject({
      nodeId: NodeIdSchema,
      message: z.string(),
    }),
  ),
  degraded: z.array(
    z.strictObject({
      nodeId: NodeIdSchema,
      kind: z.string(),
      message: z.string(),
    }),
  ),
});
export type ExportMediaSummary = z.infer<typeof ExportMediaSummarySchema>;

export const ExportArtifactSchema = z.strictObject({
  id: UuidSchema,
  kind: ExportArtifactKindSchema,
  fileName: z.string().min(1),
  mime: z.string().min(1),
  bytes: z.int().nonnegative(),
  sha256: HashSchema,
  downloadUrl: z.string().min(1),
  createdAt: UtcTimeSchema,
});
export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;

export const ExportWarningSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ExportWarning = z.infer<typeof ExportWarningSchema>;

export const ExportRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: UuidSchema,
  contentId: UuidSchema,
  renditionId: UuidSchema,
  renditionLabel: z.string(),
  revisionId: UuidSchema,
  format: ExportFormatSchema,
  status: ExportStatusSchema,
  jobId: UuidSchema,
  speakerNotes: z.boolean(),
  rendererVersion: z.string().min(1),
  title: z.string().min(1),
  media: ExportMediaSummarySchema,
  warnings: z.array(ExportWarningSchema),
  artifacts: z.array(ExportArtifactSchema),
  remoteDocumentId: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  feishuBindingId: UuidSchema.nullable(),
  error: z
    .strictObject({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .nullable(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type ExportRecord = z.infer<typeof ExportRecordSchema>;

export const OutputPreviewSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  contentId: UuidSchema,
  renditionId: UuidSchema,
  revisionId: UuidSchema,
  title: z.string(),
  templateName: z.string(),
  templateVersionId: UuidSchema.nullable(),
  templateSource: z.enum(["fixed", "builtin_fallback"]),
  rendererVersion: z.string(),
  media: ExportMediaSummarySchema,
  warnings: z.array(ExportWarningSchema),
  formats: z.array(ExportFormatSchema),
  feishuConfigured: z.boolean(),
});
export type OutputPreview = z.infer<typeof OutputPreviewSchema>;

export const ExportListSchema = z.strictObject({
  items: z.array(ExportRecordSchema),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
});
export type ExportList = z.infer<typeof ExportListSchema>;

export const OutputJobStartSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobId: UuidSchema,
  status: z.literal("queued"),
  exportId: UuidSchema.optional(),
  importId: UuidSchema.optional(),
  pullId: UuidSchema.optional(),
});
export type OutputJobStart = z.infer<typeof OutputJobStartSchema>;

export const ExportJobQuerySchema = z.strictObject({
  renditionId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ExportJobQuery = z.infer<typeof ExportJobQuerySchema>;

export const ExportOutputFileSchema = z.strictObject({
  relativePath: z.string().min(1),
  role: z.enum(["primary", "asset", "font", "manifest", "receipt"]),
  mime: z.string().min(1),
  bytes: z.int().nonnegative(),
  sha256: HashSchema,
  fileName: z.string().min(1),
});
export type ExportOutputFile = z.infer<typeof ExportOutputFileSchema>;

export const ExportJobResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("export_output"),
  exportId: UuidSchema,
  format: ExportFormatSchema,
  rendererVersion: z.string().min(1),
  files: z.array(ExportOutputFileSchema).min(1),
  primaryFile: z.string().min(1),
  warnings: z.array(ExportWarningSchema),
  manifestHash: HashSchema,
  staticizedMedia: z.array(
    z.strictObject({
      nodeId: NodeIdSchema,
      from: z.enum(["gif", "video"]),
      message: z.string().min(1),
    }),
  ),
});
export type ExportJobResult = z.infer<typeof ExportJobResultSchema>;

export const BundleBlobRecordSchema = z.strictObject({
  sha256: HashSchema,
  bytes: z.int().nonnegative(),
  mime: z.string().min(1),
  path: z.string().min(1),
});
export type BundleBlobRecord = z.infer<typeof BundleBlobRecordSchema>;

export const BundleContentSchema = z.strictObject({
  id: UuidSchema,
  title: z.string(),
  brief: BriefSchema,
  merchantId: UuidSchema.nullable(),
  status: z.enum(["draft", "ready", "archived"]),
  version: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleRenditionSchema = z.strictObject({
  id: UuidSchema,
  contentId: UuidSchema,
  kind: ContentKindSchema,
  label: z.string(),
  rootNodeId: UuidSchema,
  currentRevisionId: UuidSchema,
  derivedFromRevisionId: UuidSchema.nullable(),
  version: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleRevisionSchema = z.strictObject({
  id: UuidSchema,
  renditionId: UuidSchema,
  parentId: UuidSchema.nullable(),
  templateVersionId: UuidSchema.nullable(),
  ast: AstSchema,
  createdBy: RevisionCreatedBySchema,
  reason: z.string(),
  createdAt: UtcTimeSchema,
});

export const BundleRevisionRefSchema = z.strictObject({
  revisionId: UuidSchema,
  refType: z.string().min(1),
  refId: UuidSchema,
});

export const BundleTemplateSchema = z.strictObject({
  id: UuidSchema,
  kind: ContentKindSchema,
  name: z.string(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleTemplateVersionSchema = z.strictObject({
  id: UuidSchema,
  templateId: UuidSchema,
  version: z.int().nonnegative(),
  kind: ContentKindSchema,
  narrative: NarrativeDefinitionSchema,
  layouts: z.array(LayoutDefinitionSchema),
  theme: ThemeSchema,
  capabilities: CapabilitiesSchema,
  status: z.enum(["draft", "ready", "archived"]),
  package: TemplatePackageSchema,
  packageHash: HashSchema,
  baseVersionId: UuidSchema.nullable(),
  changeSummary: z.string().nullable(),
  slots: z.array(TemplateSlotSchema).min(1),
  rendererVersion: z.enum(["docx-1", "deck-1"]),
  createdAt: UtcTimeSchema,
});

export const BundleSourceSchema = z.strictObject({
  id: UuidSchema,
  kind: z.string(),
  canonicalKey: z.string(),
  title: z.string(),
  originalUri: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleSourceVersionSchema = z.strictObject({
  id: UuidSchema,
  sourceId: UuidSchema,
  fingerprint: HashSchema,
  snapshotBlobHash: HashSchema,
  remoteRevision: z.string().nullable(),
  capturedAt: UtcTimeSchema,
  createdAt: UtcTimeSchema,
});

export const BundleAssetSchema = z.strictObject({
  id: UuidSchema,
  blobHash: HashSchema,
  mediaKind: z.string(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleAssetVersionSchema = z.strictObject({
  id: UuidSchema,
  assetId: UuidSchema,
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  humanFields: z.record(z.string(), z.unknown()),
  version: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
});

export const BundleOccurrenceSchema = z.strictObject({
  id: UuidSchema,
  sourceVersionId: UuidSchema,
  assetId: UuidSchema.nullable(),
  locator: z.record(z.string(), z.unknown()),
  occurrenceIndex: z.int().nonnegative(),
  headingPath: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
  mediaStatus: z.enum(["discovered", "available", "missing", "unsupported"]),
  version: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleDerivativeSchema = z.strictObject({
  id: UuidSchema,
  assetId: UuidSchema,
  kind: z.string(),
  recipe: z.record(z.string(), z.unknown()),
  recipeHash: HashSchema,
  blobHash: HashSchema,
  status: z.string(),
  createdAt: UtcTimeSchema,
});

export const BundleSegmentSchema = z.strictObject({
  id: UuidSchema,
  assetId: UuidSchema,
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  derivativeId: UuidSchema.nullable(),
  title: z.string(),
  createdAt: UtcTimeSchema,
});

export const BundleFactSchema = z.strictObject({
  id: UuidSchema,
  canonicalKey: z.string(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleFactVersionSchema = z.strictObject({
  id: UuidSchema,
  factId: UuidSchema,
  value: z.unknown(),
  unit: z.string(),
  merchantId: UuidSchema.nullable(),
  period: z.unknown().nullable(),
  kind: z.enum(["measured", "estimated", "user_assertion"]),
  sourceLocator: z.record(z.string(), z.unknown()),
  status: z.enum(["unverified", "confirmed", "obsolete"]),
  createdAt: UtcTimeSchema,
});

export const BundleConversationSchema = z.strictObject({
  id: UuidSchema,
  contentId: UuidSchema,
  title: z.string(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});

export const BundleMessageSchema = z.strictObject({
  id: UuidSchema,
  conversationId: UuidSchema,
  renditionId: UuidSchema.nullable(),
  role: z.enum(["system", "user", "assistant"]),
  text: z.string(),
  targetNodeIds: z.array(NodeIdSchema),
  candidateId: UuidSchema.nullable(),
  mode: z.string(),
  jobId: UuidSchema.nullable(),
  planId: UuidSchema.nullable(),
  transcriptId: UuidSchema.nullable(),
  createdAt: UtcTimeSchema,
});

export const ProjectBundleEntitiesSchema = z.strictObject({
  contents: z.array(BundleContentSchema).length(1),
  renditions: z.array(BundleRenditionSchema),
  revisions: z.array(BundleRevisionSchema),
  revisionRefs: z.array(BundleRevisionRefSchema),
  templates: z.array(BundleTemplateSchema),
  templateVersions: z.array(BundleTemplateVersionSchema),
  sources: z.array(BundleSourceSchema),
  sourceVersions: z.array(BundleSourceVersionSchema),
  assets: z.array(BundleAssetSchema),
  assetVersions: z.array(BundleAssetVersionSchema),
  occurrences: z.array(BundleOccurrenceSchema),
  derivatives: z.array(BundleDerivativeSchema),
  segments: z.array(BundleSegmentSchema),
  facts: z.array(BundleFactSchema),
  factVersions: z.array(BundleFactVersionSchema),
  conversations: z.array(BundleConversationSchema),
  messages: z.array(BundleMessageSchema),
});
export type ProjectBundleEntities = z.infer<typeof ProjectBundleEntitiesSchema>;

export const ProjectBundleImportPayloadSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("dcw_project_bundle_payload"),
  bundleSha256: HashSchema,
  originalTitle: z.string().min(1),
  entities: ProjectBundleEntitiesSchema,
  blobs: z.array(
    BundleBlobRecordSchema.extend({
      workspacePath: z.string().min(1),
    }),
  ),
});
export type ProjectBundleImportPayload = z.infer<typeof ProjectBundleImportPayloadSchema>;

export const ProjectBundleManifestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("dcw_project_bundle"),
  bundleVersion: z.literal(1),
  internal: z.literal(true),
  notice: z.string().min(1),
  createdBy: z.string().min(1),
  appVersion: z.string().min(1),
  rendererVersion: z.literal("bundle-1"),
  contentId: UuidSchema,
  title: z.string().min(1),
  selections: z.array(
    z.strictObject({
      renditionId: UuidSchema,
      revisionIds: z.array(UuidSchema).min(1),
    }),
  ).min(1),
  entitiesPath: z.literal("data/entities.json"),
  entitiesSha256: HashSchema,
  blobs: z.array(BundleBlobRecordSchema),
  counts: z.strictObject({
    renditions: z.int().nonnegative(),
    revisions: z.int().nonnegative(),
    templates: z.int().nonnegative(),
    assets: z.int().nonnegative(),
    sources: z.int().nonnegative(),
    messages: z.int().nonnegative(),
  }),
});
export type ProjectBundleManifest = z.infer<typeof ProjectBundleManifestSchema>;

export const ProjectBundleImportRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  fileId: UuidSchema,
  title: z.string().trim().min(1).max(200).optional(),
});
export type ProjectBundleImportRequest = z.infer<typeof ProjectBundleImportRequestSchema>;

export const ProjectBundleImportStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProjectBundleImportStatus = z.infer<typeof ProjectBundleImportStatusSchema>;

export const ProjectBundleImportRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: UuidSchema,
  jobId: UuidSchema,
  bundleSha256: HashSchema,
  status: ProjectBundleImportStatusSchema,
  originalTitle: z.string().nullable(),
  contentId: UuidSchema.nullable(),
  renditionId: UuidSchema.nullable(),
  revisionId: UuidSchema.nullable(),
  report: z
    .strictObject({
      imported: z.record(z.string(), z.int().nonnegative()),
      reused: z.record(z.string(), z.int().nonnegative()),
      remapped: z.record(z.string(), z.int().nonnegative()),
      warnings: z.array(z.string()),
    })
    .nullable(),
  error: z
    .strictObject({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .nullable(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type ProjectBundleImportRecord = z.infer<typeof ProjectBundleImportRecordSchema>;

export const BundleImportJobResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("project_bundle_import"),
  importId: UuidSchema,
  bundleSha256: HashSchema,
  payloadPath: z.string().min(1),
  payloadSha256: HashSchema,
  originalTitle: z.string(),
  counts: z.record(z.string(), z.int().nonnegative()),
});
export type BundleImportJobResult = z.infer<typeof BundleImportJobResultSchema>;

export const FeishuPublishResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("feishu_publish"),
  exportId: UuidSchema,
  documentId: z.string().min(1),
  documentUrl: z.string().url(),
  blockMap: z.record(z.string(), z.string()),
  mediaMap: z.record(z.string(), z.string()),
  readbackHash: HashSchema,
  warnings: z.array(ExportWarningSchema),
});
export type FeishuPublishResult = z.infer<typeof FeishuPublishResultSchema>;

export const FeishuPullJobResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("feishu_pull"),
  bindingId: UuidSchema,
  expectedLocalRevisionId: UuidSchema,
  documentId: z.string().min(1),
  documentUrl: z.string().url(),
  remoteRevision: z.string().nullable(),
  sourceTitle: z.string().min(1),
  syntheticSourceVersionId: UuidSchema,
  ast: AstSchema,
  snapshotPath: z.string().min(1),
  snapshotSha256: HashSchema,
  media: z.array(
    z.strictObject({
      relativePath: z.string().min(1),
      sha256: HashSchema,
      bytes: z.int().nonnegative(),
      mime: z.string().min(1),
      remoteToken: z.string().min(1),
      blockId: z.string().min(1),
      assetId: UuidSchema,
      assetVersionId: UuidSchema,
      occurrenceId: UuidSchema,
    }),
  ),
  warnings: z.array(ExportWarningSchema),
});
export type FeishuPullJobResult = z.infer<typeof FeishuPullJobResultSchema>;

export const FeishuBindingRecordSchema = z.strictObject({
  id: UuidSchema,
  renditionId: UuidSchema,
  exportedRevisionId: UuidSchema,
  remoteDocumentId: z.string().min(1),
  remoteUrl: z.string().url(),
  blockMap: z.record(z.string(), z.string()),
  mediaMap: z.record(z.string(), z.string()),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type FeishuBindingRecord = z.infer<typeof FeishuBindingRecordSchema>;

export const PullRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: UuidSchema,
  bindingId: UuidSchema,
  jobId: UuidSchema,
  sourceVersionId: UuidSchema.nullable(),
  baseRevisionId: UuidSchema,
  observedCurrentRevisionId: UuidSchema,
  status: z.enum(["queued", "preview", "accepted", "rejected", "failed"]),
  localRevisionId: UuidSchema.nullable(),
  ast: AstSchema.nullable(),
  diffCount: z.int().nonnegative(),
  warnings: z.array(ExportWarningSchema),
  acceptedRenditionId: UuidSchema.nullable(),
  acceptedRevisionId: UuidSchema.nullable(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type PullRecord = z.infer<typeof PullRecordSchema>;

export const PullRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedLocalRevisionId: UuidSchema,
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const AcceptPullRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedLocalRevisionId: UuidSchema,
  label: z.string().trim().min(1).max(80).default("飞书取回"),
});
export type AcceptPullRequest = z.infer<typeof AcceptPullRequestSchema>;

export const FeishuAttachRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  documentId: z.string().trim().min(1),
  documentUrl: z.string().url(),
});
export type FeishuAttachRequest = z.infer<typeof FeishuAttachRequestSchema>;

export const OutputDecisionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("feishu_attach"),
      documentId: z.string().min(1),
      documentUrl: z.string().url(),
    }),
    z.strictObject({
      kind: z.literal("feishu_retry_create"),
      confirmedNoRemoteDocument: z.literal(true),
    }),
  ])
  .nullable();
export type OutputDecision = z.infer<typeof OutputDecisionSchema>;
