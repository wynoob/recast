import { z } from "zod";
import {
  AstSchema,
  ContentKindSchema,
  RevisionRecordSchema,
} from "./ast.js";
import {
  NodeIdSchema,
  SchemaVersionSchema,
  SourceVersionIdSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";
import { AssetSummaryV2Schema } from "./imports.js";

export const ContentStatusSchema = z.enum(["draft", "ready", "archived"]);
export const AssetMediaKindSchema = z.enum(["image", "gif", "video", "document", "audio"]);

export const ErrorCodeSchema = z.enum([
  "COMPOSITION_NOT_FOUND", "COMPOSITION_CONFLICT", "COMPOSITION_CONFIRMED", "PROPOSAL_STALE", "COMPOSITION_GAPS", "DRAFT_INVALID", "DELIVERY_IDENTITY_CONFLICT",
  "VALIDATION_ERROR",
  "HOST_NOT_ALLOWED",
  "ORIGIN_NOT_ALLOWED",
  "CSRF_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "PREVIEW_STALE",
  "DECISIONS_INVALID",
  "CANDIDATE_TERMINAL",
  "CANDIDATE_ALREADY_ACCEPTED",
  "PLAN_ACK_REQUIRED",
  "TARGET_SCOPE_INVALID",
  "REFERENCE_HISTORY_UNRESOLVED",
  "AST_INVALID",
  "TEMPLATE_INVALID",
  "TEMPLATE_NOT_READY",
  "TEMPLATE_VERSION_CONFLICT",
  "TITLE_CAPACITY_EXCEEDED",
  "UNPLACED_OWNER_REQUIRED",
  "LOCKED_FIELD",
  "UNKNOWN_REFERENCE",
  "PATH_NOT_ALLOWED",
  "SCHEMA_INVALID",
  "JOB_STALE_LEASE",
  "JOB_NOT_RESUMABLE",
  "JOB_CANCELLED",
  "PORT_IN_USE",
  "MIGRATION_FAILED",
  "REMOTE_RESULT_UNKNOWN",
  "SOURCE_UNREADABLE",
  "MEDIA_PERMISSION_DENIED",
  "MISSING_DEPENDENCY",
  "UNSUPPORTED_FORMAT",
  "MODEL_CAPABILITY_MISSING",
  "MODEL_SCHEMA_INVALID",
  "EXPORT_MEDIA_MISSING",
  "BUNDLE_INVALID",
  "FEISHU_AUTH_MISSING",
  "DISK_FULL",
  "ASSET_VERSION_CONFLICT",
  "CHUNK_HASH_MISMATCH",
  "UPLOAD_ORDER_INVALID",
  "CAPACITY_EXCEEDED",
  "SOURCE_CHANGED_RESCAN_REQUIRED",
  "SYMLINK_OUTSIDE_ROOT",
  "PAYLOAD_TOO_LARGE",
  "MAPPING_TOO_LARGE",
  "FACT_CONFLICT",
  "FACT_VERSION_CONFLICT",
  "INDEX_TEXT_TOO_LONG",
  "SEARCH_SELECTION_STALE",
  "CALL_IDENTITY_CONFLICT",
  "MODEL_RESULT_UNKNOWN",
  "STAGED_MEDIA_CONFLICT",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).default({}),
  }),
  requestId: z.string(),
});

export const HealthSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  status: z.literal("ok"),
  appVersion: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  database: z.strictObject({
    status: z.literal("ok"),
    journalMode: z.string(),
    foreignKeys: z.boolean(),
    busyTimeoutMs: z.int().nonnegative(),
    migrationCount: z.int().nonnegative(),
  }),
  csrfToken: z.string().min(1),
  workers: z.strictObject({
    configured: z.int().positive(),
    ready: z.int().nonnegative(),
  }),
});
export type Health = z.infer<typeof HealthSchema>;

export const CapabilityStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unconfigured") }),
  z.strictObject({ status: z.literal("unverified"), providerId: z.string(), modelId: z.string() }),
  z.strictObject({
    status: z.literal("configured"),
    providerId: z.string(),
    modelId: z.string(),
    probeJobId: z.string().nullable(),
  }),
  z.strictObject({
    status: z.literal("probe_failed"),
    errorCode: z.string(),
    message: z.string(),
  }),
]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

export const ProviderRoleSchema = z.enum(["text", "embedding", "vision", "asr"]);
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;

export const LocalImportFeatureStateSchema = z.enum([
  "not_implemented_t02",
  "implemented_pending_acceptance",
  "available_t02",
]);
export type LocalImportFeatureState = z.infer<typeof LocalImportFeatureStateSchema>;
export const TemplateFeatureStateSchema = z.enum([
  "not_implemented_t05",
  "implemented_pending_acceptance",
  "available_t05",
]);
export type TemplateFeatureState = z.infer<typeof TemplateFeatureStateSchema>;
export const OutputFeatureStateSchema = z.enum([
  "not_implemented_t07",
  "implemented_pending_acceptance",
  "available_t07",
]);
export type OutputFeatureState = z.infer<typeof OutputFeatureStateSchema>;
export const EditorFeatureStateSchema = z.enum([
  "not_implemented_t06",
  "implemented_pending_acceptance",
  "available_t06",
]);
export type EditorFeatureState = z.infer<typeof EditorFeatureStateSchema>;

export const SettingsSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  providers: z.strictObject({
    text: CapabilityStateSchema,
    embedding: CapabilityStateSchema,
    vision: CapabilityStateSchema,
    asr: CapabilityStateSchema,
  }),
  feishu: CapabilityStateSchema,
  storage: z.strictObject({
    dataRoot: z.string(),
    blobStore: z.literal("content_addressed"),
  }),
  workers: z.strictObject({
    poolSize: z.int().positive(),
    leaseSeconds: z.literal(30),
    heartbeatSeconds: z.literal(10),
  }),
  features: z.strictObject({
    localImport: LocalImportFeatureStateSchema,
    documentSearch: z.literal("implemented_pending_acceptance"),
    localFacts: z.literal("implemented_pending_acceptance"),
    templates: TemplateFeatureStateSchema,
    editor: EditorFeatureStateSchema,
    outputs: OutputFeatureStateSchema,
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const BriefInputSchema = z.strictObject({
  goal: z.string(),
  audience: z.array(z.string()),
  merchantId: UuidSchema.nullable(),
  durationMinutes: z.number().positive().nullable(),
  userOutline: z.array(
    z.strictObject({
      id: NodeIdSchema,
      title: z.string(),
    }),
  ),
  mustKeepOutline: z.boolean(),
  tone: z.string(),
  sourceScope: z.strictObject({
    sourceVersionIds: z.array(SourceVersionIdSchema),
    excludeIds: z.array(UuidSchema),
  }),
  unresolvedQuestions: z.array(z.string()),
});
export type BriefInput = z.infer<typeof BriefInputSchema>;

export const BriefSchema = BriefInputSchema.extend({
  schemaVersion: SchemaVersionSchema,
  contentId: UuidSchema,
  targetKind: ContentKindSchema,
});
export type Brief = z.infer<typeof BriefSchema>;

export const CreateContentRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  title: z.string().trim().min(1).max(200),
  kind: ContentKindSchema,
  brief: BriefInputSchema.optional(),
});
export type CreateContentRequest = z.infer<typeof CreateContentRequestSchema>;

export const UpdateContentRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedVersion: z.int().nonnegative(),
  title: z.string().trim().min(1).max(200).optional(),
  brief: BriefInputSchema.optional(),
});
export type UpdateContentRequest = z.infer<typeof UpdateContentRequestSchema>;

export const RenditionSummarySchema = z.strictObject({
  id: UuidSchema,
  kind: ContentKindSchema,
  label: z.string(),
  rootNodeId: UuidSchema,
  currentRevisionId: UuidSchema,
  derivedFromRevisionId: UuidSchema.nullable(),
});

export const ContentSummarySchema = z.strictObject({
  id: UuidSchema,
  title: z.string(),
  status: ContentStatusSchema,
  version: z.int().nonnegative(),
  kinds: z.array(ContentKindSchema),
  renditionCount: z.int().nonnegative(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type ContentSummary = z.infer<typeof ContentSummarySchema>;

export const ContentDetailSchema = ContentSummarySchema.extend({
  brief: BriefSchema,
  renditions: z.array(
    RenditionSummarySchema.extend({
      revision: RevisionRecordSchema,
    }),
  ),
  conversations: z.array(
    z.strictObject({
      id: UuidSchema,
      title: z.string(),
      messageCount: z.int().nonnegative(),
      createdAt: UtcTimeSchema,
    }),
  ),
});
export type ContentDetail = z.infer<typeof ContentDetailSchema>;

export const AssetSummarySchema = z.strictObject({
  id: UuidSchema,
  mediaKind: AssetMediaKindSchema,
  title: z.string(),
  merchant: z.string().nullable(),
  availability: z.enum(["available", "missing", "unsupported"]),
  createdAt: UtcTimeSchema,
});
export type AssetSummary = z.infer<typeof AssetSummarySchema>;

export const CollectionSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.int().nonnegative(),
  });

export const ContentListSchema = CollectionSchema(ContentSummarySchema);
export type ContentList = z.infer<typeof ContentListSchema>;
export const AssetListSchema = z.strictObject({
  items: z.array(AssetSummaryV2Schema),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
  groupCounts: z.strictObject({
    mp4: z.int().nonnegative(),
    gif: z.int().nonnegative(),
    image: z.int().nonnegative(),
    markdownSources: z.int().nonnegative(),
    documentSources: z.int().nonnegative(),
    missingOccurrences: z.int().nonnegative(),
  }),
});
export type AssetList = z.infer<typeof AssetListSchema>;
export const RevisionEnvelopeSchema = z.strictObject({
  revision: RevisionRecordSchema,
  ast: AstSchema,
});

export const ApiSuccessSchema = <T extends z.ZodType>(data: T) =>
  z.strictObject({
    data,
    requestId: z.string(),
  });

export const NullableCursorSchema = z.string().max(512).nullable();

export const RemoteOperationStateSchema = z.enum([
  "prepared",
  "dispatched",
  "confirmed",
  "unknown",
]);
export type RemoteOperationState = z.infer<typeof RemoteOperationStateSchema>;

export const RemoteOperationKindSchema = z.enum([
  "feishu_create_document",
  "feishu_create_blocks",
  "feishu_update_blocks",
  "feishu_upload_media",
]);
export type RemoteOperationKind = z.infer<typeof RemoteOperationKindSchema>;

export const RemoteOperationSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  operationId: UuidSchema,
  jobId: UuidSchema,
  attempt: z.int().positive(),
  leaseGeneration: z.int().positive(),
  kind: RemoteOperationKindSchema,
  state: RemoteOperationStateSchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  remoteClientToken: z.string().nullable(),
  recovery: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("none") }),
      z.strictObject({
        kind: z.literal("waiting_input_remote_result_unknown"),
        message: z.string(),
      }),
      z.strictObject({ kind: z.literal("remote_verified"), remoteId: z.string() }),
    ])
    .optional(),
});
export type RemoteOperation = z.infer<typeof RemoteOperationSchema>;
