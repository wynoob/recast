import { CompositionTaskSchema, CompositionResponseSchema } from "./composition.js";
import { z } from "zod";
import { ErrorCodeSchema } from "./api.js";
import {
  HashSchema,
  JobIdSchema,
  SchemaVersionSchema,
  TemplateVersionIdSchema,
  UtcTimeSchema,
  UuidSchema,
  WorkerFenceSchema,
} from "./ids.js";
import { AstSchema } from "./ast.js";
import {
  ReadyRenderEvidenceSchema,
  TemplateInstanceSchema,
  TemplatePackageSchema,
  TemplateValidationResultSchema,
} from "./templates.js";
import {
  ImportCheckpointSchema,
  ImportResultSchema,
  ItemResultMessageSchema,
  ScanCheckpointSchema,
  PathIdentitySchema,
} from "./imports.js";
import { AssetMapSelectionSchema } from "./asset-map.js";
import {
  BundleImportJobResultSchema,
  BundleBlobRecordSchema,
  ExportJobResultSchema,
  OutputMediaPlanItemSchema,
  ExportOptionsSchema,
  FeishuPullJobResultSchema,
  FeishuPublishResultSchema,
  OutputDecisionSchema,
  ProjectBundleEntitiesSchema,
} from "./outputs.js";
import {
  AuthoringOperationSchema,
  ClaimSchema,
} from "./authoring.js";

export const JobStateSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobTypeSchema = z.enum([
  "local_env_probe",
  "fixture_long",
  "local_scan",
  "local_import",
  "template_validate",
  "export_output",
  "project_bundle_import",
  "feishu_publish",
  "feishu_pull",
  "authoring_provider",
  "composition_provider",
  "authoring_transcription",
  "authoring_probe",
]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const JobInputSchema = z.union([
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("local_env_probe"),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("fixture_long"),
    steps: z.int().min(1).max(50),
    stepMs: z.int().min(20).max(5_000),
    failAt: z.int().positive().optional(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("local_scan"),
    scanId: UuidSchema,
    sourceKind: z.literal("local_directory"),
    rootPath: z.string().min(1),
    rootPathIdentity: z.array(PathIdentitySchema).optional(),
    scannerVersion: z.literal("dcw-directory-scan/1"),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("local_scan"),
    scanId: UuidSchema,
    sourceKind: z.literal("upload"),
    fileIds: z.array(UuidSchema).min(1).max(100),
    scannerVersion: z.literal("dcw-directory-scan/1"),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("local_import"),
    importId: UuidSchema,
    scanId: UuidSchema,
    selectedItemIds: z.array(UuidSchema).min(1),
    excludedItemIds: z.array(UuidSchema),
    assetMap: AssetMapSelectionSchema.optional(),
    options: z.strictObject({
      generatePreviews: z.literal(true),
      ocr: z.literal("blocked"),
      allowExternalModel: z.literal(false),
      allowFeishu: z.literal(false),
    }),
    processorVersions: z.record(z.string(), z.string()),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("template_validate"),
    templateVersionId: UuidSchema,
    templateHash: HashSchema,
    templatePackage: TemplatePackageSchema,
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("export_output"),
    exportId: UuidSchema,
    contentId: UuidSchema,
    renditionId: UuidSchema,
    revisionId: UuidSchema,
    format: z.enum(["html_zip", "pdf", "project_bundle"]),
    title: z.string().min(1).max(200),
    ast: AstSchema,
    templateVersionId: TemplateVersionIdSchema.nullable(),
    templatePackage: TemplatePackageSchema,
    options: ExportOptionsSchema,
    media: z.array(OutputMediaPlanItemSchema).max(2_000),
    bundle: z
      .strictObject({
        entities: ProjectBundleEntitiesSchema,
        blobs: z.array(BundleBlobRecordSchema).max(20_000),
        selections: z.array(
          z.strictObject({
            renditionId: UuidSchema,
            revisionIds: z.array(UuidSchema).min(1),
          }),
        ).min(1),
      })
      .optional(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("project_bundle_import"),
    importId: UuidSchema,
    bundleSha256: HashSchema,
    bundlePath: z.string().min(1),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("feishu_publish"),
    exportId: UuidSchema,
    contentId: UuidSchema,
    renditionId: UuidSchema,
    revisionId: UuidSchema,
    title: z.string().min(1).max(200),
    ast: AstSchema,
    templateVersionId: TemplateVersionIdSchema.nullable(),
    templatePackage: TemplatePackageSchema,
    options: ExportOptionsSchema,
    media: z.array(OutputMediaPlanItemSchema).max(2_000),
    folderToken: z.string().max(512).nullable(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("feishu_pull"),
    pullId: UuidSchema,
    bindingId: UuidSchema,
    expectedLocalRevisionId: UuidSchema,
    remoteDocumentId: z.string().min(1),
    remoteUrl: z.string().url(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("composition_provider"),
    contentId: UuidSchema,
    renditionId: UuidSchema,
    inputId: UuidSchema.nullable(),
    contentVersion: z.int().nonnegative(),
    task: CompositionTaskSchema,
    provider: z.strictObject({
      role: z.literal("text"),
      providerId: z.string().min(1),
      baseUrl: z.string().url(),
      modelId: z.string().min(1),
      credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      timeoutMs: z.int().min(1_000).max(300_000),
    }),
    requestEnvelope: z.strictObject({
      role: z.literal("text"),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      providerConfigVersion: z.string().min(1),
      promptVersion: z.string().min(1),
      responseSchemaId: z.enum(["composition_intent/1", "composition_recommend/1", "composition_doc/1", "composition_deck/1"]),
      messages: z.array(z.strictObject({
        role: z.enum(["system", "user"]),
        content: z.string(),
      })).min(1),
      toolsDisabled: z.literal(true),
      timeoutMs: z.int().positive(),
    }),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("authoring_provider"),
    contentId: UuidSchema,
    renditionId: UuidSchema,
    inputId: UuidSchema,
    task: z.enum(["plan", "generate", "revise"]),
    provider: z.strictObject({
      role: z.literal("text"),
      providerId: z.string().min(1),
      baseUrl: z.string().url(),
      modelId: z.string().min(1),
      credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      timeoutMs: z.int().min(1_000).max(300_000),
    }),
    requestEnvelope: z.strictObject({
      role: z.literal("text"),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      providerConfigVersion: z.string().min(1),
      promptVersion: z.string().min(1),
      responseSchemaId: z.literal("authoring_operations/1"),
      messages: z.array(z.strictObject({
        role: z.enum(["system", "user"]),
        content: z.string(),
      })).min(1),
      toolsDisabled: z.literal(true),
      timeoutMs: z.int().positive(),
    }),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("authoring_probe"),
    provider: z.strictObject({
      role: z.literal("text"),
      providerId: z.string().min(1),
      baseUrl: z.string().url(),
      modelId: z.string().min(1),
      credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      timeoutMs: z.int().min(1_000).max(300_000),
    }),
    requestEnvelope: z.strictObject({
      role: z.literal("text"),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      providerConfigVersion: z.string().min(1),
      promptVersion: z.literal("t06-provider-probe/1"),
      responseSchemaId: z.literal("provider_probe/1"),
      messages: z.array(z.strictObject({
        role: z.enum(["system", "user"]),
        content: z.string(),
      })).min(1),
      toolsDisabled: z.literal(true),
      timeoutMs: z.int().positive(),
    }),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("authoring_transcription"),
    contentId: UuidSchema,
    renditionId: UuidSchema.nullable(),
    provider: z.strictObject({
      role: z.literal("asr"),
      providerId: z.string().min(1),
      baseUrl: z.string().url(),
      modelId: z.string().min(1),
      credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      timeoutMs: z.int().min(1_000).max(300_000),
    }),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    language: z.string().min(2).max(20).default("zh"),
    requestEnvelope: z.strictObject({
      role: z.literal("asr"),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      providerConfigVersion: z.string().min(1),
      promptVersion: z.string().min(1),
      responseSchemaId: z.literal("transcript_text/1"),
      language: z.string(),
      audioBytes: z.int().positive(),
      audioSha256: HashSchema,
      mimeType: z.string(),
      toolsDisabled: z.literal(true),
      timeoutMs: z.int().positive(),
    }),
  }),
]);
export type JobInput = z.infer<typeof JobInputSchema>;

export const LocalProbeCheckpointSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("local_env_probe"),
  completedSteps: z.array(z.string()),
});
export const FixtureCheckpointSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobType: z.literal("fixture_long"),
  cursor: z.int().nonnegative(),
  digest: HashSchema,
});
export type FixtureCheckpoint = z.infer<typeof FixtureCheckpointSchema>;
export const JobCheckpointSchema = z.discriminatedUnion("jobType", [
  LocalProbeCheckpointSchema,
  FixtureCheckpointSchema,
  ScanCheckpointSchema,
  ImportCheckpointSchema,
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("export_output"),
    completed: z.array(z.string()),
    primaryFile: z.string().nullable(),
    manifestHash: HashSchema.nullable(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("project_bundle_import"),
    phase: z.enum(["downloaded", "validated", "staged"]),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("feishu_publish"),
    phase: z.enum([
      "not_started",
      "document_created",
      "blocks_created",
      "media_uploaded",
      "readback_verified",
    ]),
    documentId: z.string().nullable(),
    documentUrl: z.string().url().nullable(),
    batchIndex: z.int().nonnegative(),
    blockMap: z.record(z.string(), z.string()),
    mediaMap: z.record(z.string(), z.string()),
    pendingTableCells: z.array(z.string()).default([]),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("feishu_pull"),
    phase: z.enum(["not_started", "blocks_read", "media_downloaded", "snapshot_written"]),
    pageToken: z.string().nullable(),
  }),
]);
export type JobCheckpoint = z.infer<typeof JobCheckpointSchema>;

export const JobResultSchema = z.discriminatedUnion("jobType", [
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("local_env_probe"),
    nodeVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
    sharpVersion: z.string(),
    pngBytes: z.int().positive(),
    pngSha256: HashSchema,
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("fixture_long"),
    completedSteps: z.int().nonnegative(),
    digest: HashSchema,
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("local_scan"),
    scanId: UuidSchema,
    counts: z.record(z.string(), z.int().nonnegative()),
    manifestHash: HashSchema,
  }),
  ImportResultSchema.extend({ schemaVersion: SchemaVersionSchema }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("template_validate"),
    templateVersionId: UuidSchema,
    templateHash: HashSchema,
    ok: z.boolean(),
    message: z.string(),
    astHash: HashSchema.nullable(),
    sampleHash: HashSchema.nullable(),
    instance: TemplateInstanceSchema.nullable(),
    sample: z.strictObject({
      ast: AstSchema,
      media: z.record(z.string(), z.string()),
    }).nullable(),
    evidence: ReadyRenderEvidenceSchema.nullable(),
    validation: TemplateValidationResultSchema,
    artifacts: z.strictObject({
      htmlPath: z.string().min(1),
      pdfPath: z.string().min(1),
      screenshotPath: z.string().min(1),
    }).nullable(),
  }),
  ExportJobResultSchema,
  BundleImportJobResultSchema,
  FeishuPublishResultSchema,
  FeishuPullJobResultSchema,
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("composition_provider"),
    contentId: UuidSchema,
    renditionId: UuidSchema,
    inputId: UuidSchema.nullable(),
    response: CompositionResponseSchema,
    rawResponse: z.string(),
    responseHash: z.string().regex(/^resp1:[a-f0-9]{64}$/),
    providerRequestId: z.string().nullable(),
    cost: z.number().finite().nonnegative().nullable(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("authoring_provider"),
    contentId: UuidSchema,
    renditionId: UuidSchema,
    inputId: UuidSchema,
    operations: z.array(AuthoringOperationSchema),
    claims: z.array(ClaimSchema),
    rawResponse: z.string(),
    responseHash: z.string().regex(/^resp1:[a-f0-9]{64}$/),
    providerRequestId: z.string().nullable(),
    cost: z.number().finite().nonnegative().nullable(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("authoring_probe"),
    providerId: UuidSchema,
    ok: z.literal(true),
    rawResponse: z.string(),
    responseHash: z.string().regex(/^resp1:[a-f0-9]{64}$/),
    cost: z.number().finite().nonnegative().nullable(),
  }),
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    jobType: z.literal("authoring_transcription"),
    contentId: UuidSchema,
    text: z.string(),
    rawResponse: z.string(),
    responseHash: z.string().regex(/^resp1:[a-f0-9]{64}$/),
    providerRequestId: z.string().nullable(),
    cost: z.number().finite().nonnegative().nullable(),
  }),
]);
export type JobResult = z.infer<typeof JobResultSchema>;

export const JobErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

export const JobSnapshotSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: JobIdSchema,
  type: JobTypeSchema,
  state: JobStateSchema,
  phase: z.string(),
  attempt: z.int().nonnegative(),
  maxAttempts: z.int().positive(),
  leaseGeneration: z.int().nonnegative(),
  leaseUntil: UtcTimeSchema.nullable(),
  cancelRequested: z.boolean(),
  checkpoint: JobCheckpointSchema.nullable(),
  result: JobResultSchema.nullable(),
  error: JobErrorSchema.nullable(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

export const JobEventKindSchema = z.enum([
  "progress",
  "item_result",
  "warning",
  "needs_input",
  "completed",
  "error",
]);
export type JobEventKind = z.infer<typeof JobEventKindSchema>;

export const JobEventPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("progress"),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("item_result"),
    itemId: z.string(),
    state: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("warning"),
    code: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("needs_input"),
    reason: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("completed"),
    state: z.enum(["succeeded", "partial", "cancelled"]),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
]);
export type JobEventPayload = z.infer<typeof JobEventPayloadSchema>;

export const JobEventSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  seq: z.int().positive(),
  jobId: JobIdSchema,
  kind: JobEventKindSchema,
  phase: z.string(),
  done: z.int().nonnegative().nullable(),
  total: z.int().nonnegative().nullable(),
  payload: JobEventPayloadSchema,
  at: UtcTimeSchema,
});
export type JobEvent = z.infer<typeof JobEventSchema>;

export { WorkerFenceSchema };
export type { WorkerFence } from "./ids.js";

export const CreateLocalProbeRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
});
export const CreateFixtureJobRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  steps: z.int().min(1).max(50),
  stepMs: z.int().min(20).max(5_000),
  failAt: z.int().positive().optional(),
});

export const JobGrantSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  jobId: JobIdSchema,
  fence: WorkerFenceSchema,
  inputHash: HashSchema,
  input: JobInputSchema,
  checkpoint: JobCheckpointSchema.nullable(),
  workspacePath: z.string().min(1).optional(),
  manifestPath: z.string().min(1).optional(),
  blobRoot: z.string().min(1).optional(),
  remoteDecision: OutputDecisionSchema.optional(),
});
export type JobGrant = z.infer<typeof JobGrantSchema>;

export const WorkerHeartbeatSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("heartbeat"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  sentAt: UtcTimeSchema,
});
export const WorkerEventSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("event"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  kind: JobEventKindSchema,
  phase: z.string(),
  done: z.int().nonnegative().nullable(),
  total: z.int().nonnegative().nullable(),
  payload: JobEventPayloadSchema,
});
export const WorkerCheckpointSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("checkpoint"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  checkpoint: JobCheckpointSchema,
});
export const WorkerWaitingSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("waiting"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  reason: z.string().min(1),
  message: z.string().min(1),
  checkpoint: JobCheckpointSchema,
});
export const WorkerRemoteOperationSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("remote_operation"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  operationId: UuidSchema,
  kind: z.enum([
    "feishu_create_document",
    "feishu_create_blocks",
    "feishu_update_blocks",
    "feishu_upload_media",
  ]),
  state: z.enum(["prepare", "dispatched", "confirmed", "unknown"]),
  requestHash: HashSchema,
  clientToken: z.string().nullable(),
  response: z.unknown().optional(),
});
export const WorkerFinishedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("finished"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  state: z.enum(["succeeded", "partial", "failed", "cancelled", "waiting_input"]),
  result: JobResultSchema.nullable(),
  error: JobErrorSchema.nullable(),
});
export const WorkerCallIntentSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("call_intent"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  purpose: z.enum(["planning", "generation", "revision", "transcription", "probe"]),
  callOrdinal: z.int().nonnegative(),
  requestHash: z.string().regex(/^rh1:[a-f0-9]{64}$/),
  requestEnvelope: z.record(z.string(), z.unknown()),
});
export type WorkerCallIntent = z.infer<typeof WorkerCallIntentSchema>;
export const WorkerCallResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("call_result"),
  messageId: UuidSchema,
  fence: WorkerFenceSchema,
  attemptId: UuidSchema,
  logicalCallId: z.string().regex(/^call1:[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^rh1:[a-f0-9]{64}$/),
  responseHash: z.string().regex(/^resp1:[a-f0-9]{64}$/),
  rawResponse: z.string(),
  providerRequestId: z.string().nullable(),
  cost: z.number().finite().nonnegative().nullable(),
});
export type WorkerCallResult = z.infer<typeof WorkerCallResultSchema>;
export const WorkerReadySchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("ready"),
  workerId: z.string().min(1),
  pid: z.int().positive(),
});
export const WorkerToHostMessageSchema = z.discriminatedUnion("type", [
  WorkerReadySchema,
  WorkerHeartbeatSchema,
  WorkerEventSchema,
  WorkerCheckpointSchema,
  WorkerWaitingSchema,
  WorkerRemoteOperationSchema,
  WorkerFinishedSchema,
  WorkerCallIntentSchema,
  WorkerCallResultSchema,
  ItemResultMessageSchema,
]);
export type WorkerToHostMessage = z.infer<typeof WorkerToHostMessageSchema>;

export const HostGrantMessageSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("grant"),
  grant: JobGrantSchema,
});
export const HostCancelMessageSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("cancel"),
  jobId: JobIdSchema,
  generation: z.int().positive(),
});
export const HostShutdownMessageSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("shutdown"),
});
export const HostAckMessageSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("ack"),
  messageId: UuidSchema,
  accepted: z.boolean(),
  code: ErrorCodeSchema.nullable(),
});
export const HostCallPermitSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  type: z.literal("call_permit"),
  messageId: UuidSchema,
  intentMessageId: UuidSchema,
  attemptId: UuidSchema,
  logicalCallId: z.string().regex(/^call1:[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^rh1:[a-f0-9]{64}$/),
  retransmit: z.boolean(),
});
export const HostToWorkerMessageSchema = z.discriminatedUnion("type", [
  HostGrantMessageSchema,
  HostCancelMessageSchema,
  HostShutdownMessageSchema,
  HostAckMessageSchema,
  HostCallPermitSchema,
]);
export type HostToWorkerMessage = z.infer<typeof HostToWorkerMessageSchema>;
